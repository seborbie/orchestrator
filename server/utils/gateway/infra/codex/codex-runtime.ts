import type { HostWithSecret, RemoteCodexVersionState } from "../ssh/ssh-types";
import { isRecoverableCodexInstallError } from "./codex-install-errors";
import { isCodexVersionAtLeast, SUPPORTED_CODEX_VERSION } from "./codex-version";
import { hostLifecycleBus } from "../../state/host-events";
import { currentGatewayUserId } from "../../state/memory";
import type { SshConnectionPool } from "../ssh/ssh-connection";
import { AppServerRuntimeProbe } from "./app-server-runtime-probe";
import { CodexUpgrader } from "./codex-upgrader";
import { CodexUpgradeWorkflow } from "./codex-upgrade-workflow";
import { CodexVersionChecker } from "./codex-version-checker";
import { HostVerifyService } from "../host-verify-service";

export class CodexRuntimeService {
  private readonly versionChecks = new Map<string, Promise<RemoteCodexVersionState>>();
  private readonly deferredUpgradeChecks = new Map<string, Promise<boolean>>();
  private readonly upgradeWorkflow: CodexUpgradeWorkflow;
  private readonly appServerRuntime: AppServerRuntimeProbe;
  private readonly upgrader: CodexUpgrader;
  private readonly versionChecker: CodexVersionChecker;
  private readonly verifier: HostVerifyService;

  constructor(ssh: SshConnectionPool) {
    this.appServerRuntime = new AppServerRuntimeProbe(ssh);
    this.upgrader = new CodexUpgrader(ssh);
    this.versionChecker = new CodexVersionChecker(ssh);
    this.upgradeWorkflow = new CodexUpgradeWorkflow(
      this.appServerRuntime,
      this.upgrader,
      this.versionChecker,
    );
    this.verifier = new HostVerifyService(ssh, (host) => this.ensureCodexVersion(host));
  }

  async verify(host: HostWithSecret) {
    return await this.verifier.verify(host);
  }

  async ensureCodexVersion(host: HostWithSecret): Promise<RemoteCodexVersionState> {
    const key = this.hostKey(host.id);
    const existing = this.versionChecks.get(key);
    if (existing) {
      return existing;
    }

    const check = this.checkAndUpgradeCodex(host).finally(() => {
      this.versionChecks.delete(key);
    });
    this.versionChecks.set(key, check);
    return check;
  }

  async checkAndUpgradeCodex(host: HostWithSecret): Promise<RemoteCodexVersionState> {
    try {
      hostLifecycleBus.emit({
        hostId: host.id,
        status: "checkingVersion",
        message: `Checking the remote Codex version on ${hostDisplayName(host)}`,
      });
      const supportedVersion = SUPPORTED_CODEX_VERSION;
      const beforeVersion = await this.versionChecker.readVersionOrRecoverableMissing(host);
      const runtimeState = await this.appServerRuntime.readState(host);
      const appServerVersion = runtimeState.appServerVersion;
      const currentRuntimeVersion = appServerVersion ?? beforeVersion;
      const cliVersionSupported = isCodexVersionAtLeast(beforeVersion, supportedVersion);
      const runtimeVersionSupported = isCodexVersionAtLeast(
        currentRuntimeVersion,
        supportedVersion,
      );

      if (
        runtimeState.running === true &&
        runtimeState.versionError !== null &&
        runtimeState.versionError !== ""
      ) {
        hostLifecycleBus.emit({
          hostId: host.id,
          status: "restarting",
          message: `The remote Codex app-server on ${hostDisplayName(host)} could not complete its handshake; restarting: ${runtimeState.versionError}`,
        });
        await this.appServerRuntime.terminateUnmanaged(host);
        return {
          version: beforeVersion,
          appServerVersion: null,
          supportedVersion,
          beforeVersion,
          upgraded: false,
        };
      }

      if (cliVersionSupported && runtimeVersionSupported) {
        hostLifecycleBus.emit({
          hostId: host.id,
          status: "connecting",
          message: `Remote Codex on ${hostDisplayName(host)} is already up to date at ${beforeVersion}`,
        });
        return {
          version: beforeVersion,
          appServerVersion,
          supportedVersion,
          beforeVersion,
          upgraded: false,
        };
      }

      if (runtimeState.running) {
        if (await this.appServerRuntime.hasActiveLoadedThread(host)) {
          hostLifecycleBus.emit({
            hostId: host.id,
            status: "connecting",
            message: `${hostDisplayName(host)} still has an active thread; the Codex ${currentRuntimeVersion} -> ${supportedVersion} upgrade has been deferred`,
          });
          return {
            version: beforeVersion,
            appServerVersion,
            supportedVersion,
            beforeVersion,
            upgraded: false,
            deferredUpgrade: true,
          };
        }
      }

      if (!cliVersionSupported) {
        return await this.upgradeWorkflow.upgradeOutdatedCli(host, supportedVersion, beforeVersion);
      }

      if (runtimeState.running) await this.appServerRuntime.terminateUnmanaged(host);
      hostLifecycleBus.emit({
        hostId: host.id,
        status: "restarting",
        message: `The remote Codex CLI on ${hostDisplayName(host)} is already at ${beforeVersion}; restarting the older app-server ${currentRuntimeVersion}`,
      });
      return {
        version: beforeVersion,
        appServerVersion: null,
        supportedVersion,
        beforeVersion,
        upgraded: false,
      };
    } catch (error) {
      hostLifecycleBus.emit({
        hostId: host.id,
        status: "failed",
        message: messageFromError(error),
      });
      throw error;
    }
  }

  clearVersionCheck(hostId: number) {
    this.versionChecks.delete(this.hostKey(hostId));
  }

  completeDeferredUpgrade(host: HostWithSecret) {
    const key = this.hostKey(host.id);
    const pending = this.deferredUpgradeChecks.get(key);
    if (pending) return pending;

    const check = this.stopIdleOutdatedRuntime(host).finally(() => {
      if (this.deferredUpgradeChecks.get(key) === check) {
        this.deferredUpgradeChecks.delete(key);
      }
    });
    this.deferredUpgradeChecks.set(key, check);
    return check;
  }

  async repairAfterProxyFailure(
    host: HostWithSecret,
    error: unknown,
  ): Promise<RemoteCodexVersionState> {
    if (!isRecoverableCodexInstallError(error)) {
      throw error;
    }

    hostLifecycleBus.emit({
      hostId: host.id,
      status: "upgrading",
      message: `The remote Codex app-server on ${hostDisplayName(host)} failed to start; reinstalling ${SUPPORTED_CODEX_VERSION}: ${messageFromError(error)}`,
    });

    return await this.upgradeWorkflow.repair(host);
  }

  private async stopIdleOutdatedRuntime(host: HostWithSecret) {
    if (await this.appServerRuntime.hasActiveLoadedThread(host)) return false;
    hostLifecycleBus.emit({
      hostId: host.id,
      status: "restarting",
      message: `The active thread on ${hostDisplayName(host)} has ended; starting the deferred Codex upgrade`,
    });
    await this.appServerRuntime.terminateUnmanaged(host);
    this.clearVersionCheck(host.id);
    return true;
  }

  private hostKey(hostId: number) {
    return `${currentGatewayUserId() ?? "anonymous"}:${hostId}`;
  }
}

function hostDisplayName(host: HostWithSecret) {
  return host.name || host.sshHost;
}

function messageFromError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

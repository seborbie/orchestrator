import type { HostWithSecret } from "../infra/ssh/ssh-types";
import { notificationCenter } from "../notifications/notification-center";
import { TmuxMonitorRepository } from "./repository";
import type { StoredTmuxMonitor } from "./types";
import { firstNonEmptyString } from "~~/shared/utils/strings";

export class TmuxMonitorNotifier {
  private readonly pendingMonitorIds = new Set<number>();

  constructor(private readonly repository: TmuxMonitorRepository) {}

  async publishCompletion(host: HostWithSecret, monitor: StoredTmuxMonitor) {
    if (this.pendingMonitorIds.has(monitor.id)) return;
    const persisted = this.repository.getOwned(monitor.userId, monitor.id);
    if (persisted === null || persisted.notificationSentAt !== null) return;

    this.pendingMonitorIds.add(monitor.id);
    try {
      await notificationCenter.publish({
        key: `tmux-monitor:${monitor.userId}:${monitor.id}:completed`,
        title: `Tmux task ended · ${firstNonEmptyString([host.name, host.sshHost]) ?? String(host.id)} · ${monitor.sessionName}`,
        body: [
          `Host: ${firstNonEmptyString([host.name, host.sshHost]) ?? String(host.id)}`,
          `Thread: ${threadLabel(monitor)}`,
          `Tmux: ${monitor.sessionName}`,
          `Status: ${reasonLabel(monitor)}`,
        ].join("\n"),
        group: "tmux-monitor",
        target: {
          kind: "tmuxMonitor",
          hostId: monitor.hostId,
          monitorId: monitor.id,
          projectId: monitor.projectId,
          threadId: monitor.threadId,
        },
      });
      // Browser fan-out is synchronous and Bark resolves only after delivery (or when disabled).
      // Persist acknowledgement last so a crash or exhausted Bark retry leaves this row eligible
      // for the next poll instead of permanently losing the notification.
      this.repository.markNotificationSent(monitor.userId, monitor.id);
    } finally {
      this.pendingMonitorIds.delete(monitor.id);
    }
  }
}

function threadLabel(monitor: StoredTmuxMonitor) {
  if (monitor.threadId === null) return "Host-level monitor";
  return firstNonEmptyString([monitor.threadTitle, monitor.threadId]) ?? monitor.threadId;
}

function reasonLabel(monitor: StoredTmuxMonitor) {
  switch (monitor.completionReason) {
    case "returnedToShell":
      return "Returned to shell";
    case "sessionExited":
      return "Session exited";
    case "paneExited":
      return "Pane exited";
    case "paneReplaced":
      return "Pane was replaced";
    case "cancelled":
    case null:
      return "Monitoring completed";
  }
}

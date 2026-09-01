/**
 * Reserved daemon exit code asking the supervisor to restart the service. The portable automatic
 * upgrade uses it to hand off after the new version is live on disk: systemd maps it to a clean,
 * forced restart (`SuccessExitStatus=0 75` + `RestartForceExitStatus=75`), and launchd restarts it
 * through `KeepAlive.SuccessfulExit=false`. Any other exit path keeps its existing meaning.
 */
export const SUPERVISOR_RESTART_EXIT_CODE = 75;

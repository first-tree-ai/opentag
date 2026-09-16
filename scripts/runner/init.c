/* Small Linux init for the Runner and its native Sandbox. */
#define _GNU_SOURCE
#include <errno.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

static volatile sig_atomic_t child_pid = -1;
static volatile sig_atomic_t force_cleanup = 0;

static void forward_signal(int sig) {
  pid_t pid = (pid_t)child_pid;
  if (pid > 0 && kill(-pid, sig) < 0) kill(pid, sig);
}

static void cleanup_alarm(int sig) {
  (void)sig;
  force_cleanup = 1;
}

/* Only signal our own adopted children, including children that created another process group. */
static void signal_children(int sig) {
  char path[96];
  snprintf(path, sizeof(path), "/proc/self/task/%ld/children", (long)getpid());
  FILE *file = fopen(path, "r");
  if (!file) return;
  long pid;
  while (fscanf(file, "%ld", &pid) == 1) {
    if (pid > 0 && pid != (long)getpid()) kill((pid_t)pid, sig);
  }
  fclose(file);
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fputs("opentag-init: COMMAND [ARGS...] required\n", stderr);
    return 2;
  }
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) < 0) {
    perror("opentag-init: subreaper");
    return 1;
  }
  const int signals[] = {SIGTERM, SIGINT, SIGHUP, SIGQUIT};
  sigset_t blocked, previous;
  sigemptyset(&blocked);
  struct sigaction action = {0};
  action.sa_handler = forward_signal;
  sigemptyset(&action.sa_mask);
  for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) {
    sigaddset(&blocked, signals[i]);
    if (sigaction(signals[i], &action, NULL) < 0) return 1;
  }
  if (sigprocmask(SIG_BLOCK, &blocked, &previous) < 0) return 1;
  pid_t child = fork();
  if (child < 0) { perror("opentag-init: fork"); return 1; }
  if (child == 0) {
    for (size_t i = 0; i < sizeof(signals) / sizeof(signals[0]); i++) signal(signals[i], SIG_DFL);
    if (setsid() < 0) _exit(126);
    sigprocmask(SIG_SETMASK, &previous, NULL);
    execvp(argv[1], &argv[1]);
    perror("opentag-init: exec");
    _exit(127);
  }
  child_pid = child;
  sigprocmask(SIG_SETMASK, &previous, NULL);
  int main_status = 0, main_exited = 0;
  for (;;) {
    if (main_exited) signal_children(force_cleanup ? SIGKILL : SIGTERM);
    int status;
    pid_t reaped = waitpid(-1, &status, 0);
    if (reaped < 0) {
      if (errno == EINTR) continue;
      if (errno == ECHILD) break;
      perror("opentag-init: waitpid");
      return 1;
    }
    if (reaped == child) {
      main_status = status;
      main_exited = 1;
      child_pid = -1;
      action.sa_handler = cleanup_alarm;
      sigaction(SIGALRM, &action, NULL);
      alarm(2);
    }
  }
  alarm(0);
  if (!main_exited) return 1;
  if (WIFEXITED(main_status)) return WEXITSTATUS(main_status);
  if (WIFSIGNALED(main_status)) return 128 + WTERMSIG(main_status);
  return 1;
}

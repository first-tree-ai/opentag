let channelDefaultHomeApplied = false;

export function markChannelDefaultHomeApplied(): void {
  channelDefaultHomeApplied = true;
}

export function wasChannelDefaultHomeApplied(): boolean {
  return channelDefaultHomeApplied;
}

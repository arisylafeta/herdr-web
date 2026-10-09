export interface ScrollMetrics { scrollTop: number; scrollHeight: number; clientHeight: number }

export function isTranscriptNearBottom({ scrollTop, scrollHeight, clientHeight }: ScrollMetrics): boolean {
  return scrollHeight - clientHeight - scrollTop <= 60;
}

export function anchoredScrollTop(previous: Pick<ScrollMetrics, "scrollTop" | "scrollHeight">, scrollHeight: number): number {
  return Math.max(0, previous.scrollTop + scrollHeight - previous.scrollHeight);
}

export function transcriptScrollTop(metrics: ScrollMetrics, following: boolean, earlier?: Pick<ScrollMetrics, "scrollTop" | "scrollHeight">): number {
  if (earlier) return anchoredScrollTop(earlier, metrics.scrollHeight);
  return following ? Math.max(0, metrics.scrollHeight - metrics.clientHeight) : metrics.scrollTop;
}

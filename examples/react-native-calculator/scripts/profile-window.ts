/** Validate capture containment without accepting missing dates through NaN comparisons. */
export function validateProfileWindow(
  complete: { activeAt?: unknown; finishedAt?: unknown },
  observedActiveAt: unknown,
  sampleStartedAt: string,
  sampleFinishedAt: string,
) {
  const values = [
    complete.activeAt,
    complete.finishedAt,
    observedActiveAt,
    sampleStartedAt,
    sampleFinishedAt,
  ];
  const dates = values.map((value) => (typeof value === 'string' ? Date.parse(value) : NaN));
  const [active, finished, observed, start, end] = dates;
  if (
    dates.some((value) => !Number.isFinite(value)) ||
    active !== observed ||
    start < active ||
    end <= start ||
    end > finished
  )
    throw Error('sample extends outside the authenticated active workload; raw capture retained');
}

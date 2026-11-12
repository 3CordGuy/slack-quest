// Gathering outings as lightning bolts: lit for each one left today, dim
// for those spent. The same bolt is drawn on your plate over your hero.

/** The same 5x7 bolt as on the plate, one rect per row. */
const BOLT = "M3 0h2v1h-2zM2 1h2v1h-2zM1 2h2v1h-2zM0 3h5v1h-5zM2 4h2v1h-2zM1 5h2v1h-2zM0 6h2v1h-2z";

export function StaminaBolts({ left, max, size = 18 }: { left: number; max: number; size?: number }) {
  return (
    <span className="stamina-bolts" role="img" aria-label={`${left} of ${max} outings left today`}>
      {Array.from({ length: max }, (_, i) => (
        <svg key={i} className={i < left ? "on" : ""} viewBox="0 0 5 7" width={(size * 5) / 7} height={size} shapeRendering="crispEdges" aria-hidden>
          <path d={BOLT} />
        </svg>
      ))}
    </span>
  );
}

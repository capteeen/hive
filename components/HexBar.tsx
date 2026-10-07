/** Progress bar that fills hex cells left to right. */
export default function HexBar({ value, cells = 12, className = '' }: { value: number; cells?: number; className?: string }) {
  const on = Math.round(Math.max(0, Math.min(1, value)) * cells);
  return (
    <div className={`hexbar ${className}`} role="progressbar" aria-valuenow={Math.round(value * 100)}>
      {Array.from({ length: cells }, (_, i) => (
        <i key={i} className={i < on ? 'on' : ''} />
      ))}
    </div>
  );
}

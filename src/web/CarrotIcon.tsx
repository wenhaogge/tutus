export default function CarrotIcon({ className = '' }: { className?: string }) {
  return <span className={`carrot-icon ${className}`} aria-hidden="true"><img src="/carrot.png" alt="" /></span>;
}

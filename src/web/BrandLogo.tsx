export default function BrandLogo({ className = '' }: { className?: string }) {
  return <img className={`brand-logo ${className}`} src="/tutus-logo.png" width={43} height={43} alt="" />;
}

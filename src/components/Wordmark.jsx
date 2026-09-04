// "SideLines" wordmark per the brand guide: all-caps with the S and L set larger than the
// rest, echoing the mark's own S/L numeral. Kept as one component so both instances (sign-in
// screen, main header) always match.
export default function Wordmark({ className }) {
  return (
    <span className={className ? `sb-wordmark ${className}` : "sb-wordmark"}>
      <span className="sb-wordmark-big">S</span>ide<span className="sb-wordmark-big">L</span>ines
    </span>
  );
}

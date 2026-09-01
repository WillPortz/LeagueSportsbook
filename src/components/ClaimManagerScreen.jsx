import { useState } from "react";
import { AlertTriangle, Users } from "lucide-react";

export default function ClaimManagerScreen({ leagueName, members, onClaim, onSignOut, onBack }) {
  const [claimingId, setClaimingId] = useState(null);
  const [error, setError] = useState(null);
  const unclaimed = members.filter((m) => !m.userId);

  async function handleClaim(member) {
    setClaimingId(member.dbId);
    setError(null);
    try {
      await onClaim(member.dbId);
    } catch (err) {
      setError(err.message || "That slot was just claimed by someone else — pick another.");
    } finally {
      setClaimingId(null);
    }
  }

  return (
    <div className="sb-root">
      <div className="sb-setup">
        <div className="sb-setup-card">
          <h2>Who are you?</h2>
          <p>
            <span className="sb-league-badge">Connected</span> {leagueName}. Pick your manager
            below to link it to your account — this is one-time and only you will be able to
            act as this manager from now on.
          </p>

          {unclaimed.length === 0 ? (
            <div className="sb-empty">
              Every manager in this league has already been claimed. If that's wrong, check with
              whoever set this league up.
            </div>
          ) : (
            <div className="sb-setup-members">
              {unclaimed.map((m) => (
                <button
                  type="button"
                  key={m.id}
                  className="sb-setup-member claimable"
                  disabled={claimingId != null}
                  onClick={() => handleClaim(m)}
                >
                  <Users size={14} color="#7ea08f" />
                  <div>
                    <div>{claimingId === m.dbId ? "Claiming…" : m.name}</div>
                    {m.teamName && <span className="sub">{m.displayName}</span>}
                  </div>
                </button>
              ))}
            </div>
          )}

          {error && (
            <div className="sb-error-banner">
              <AlertTriangle size={12} /> {error}
            </div>
          )}
          {onBack ? (
            <button type="button" className="sb-signout-link" onClick={onBack}>
              Back to my league
            </button>
          ) : onSignOut && (
            <button type="button" className="sb-signout-link" onClick={onSignOut}>
              Sign out
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

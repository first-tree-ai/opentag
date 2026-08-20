import { useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError, browserApi } from "../../api.js";
import { formatDate } from "../../lib/format.js";
import { useResource } from "../../lib/resource.js";
import { AsyncState } from "../../ui/async-state.js";
import { Notice } from "../../ui/feedback.js";

export function InvitePage() {
  const { token = "" } = useParams();
  const navigate = useNavigate();
  const preview = useResource(() => browserApi.auth.invitationPreview(token), token);
  const [error, setError] = useState<string>();
  async function join() {
    try {
      await browserApi.auth.redeemInvitation(token);
      navigate("/agents");
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        navigate(`/login?next=${encodeURIComponent(`/invites/${token}`)}`);
      } else setError(cause instanceof Error ? cause.message : "The invitation could not be redeemed");
    }
  }
  return (
    <main className="center-card">
      <AsyncState state={preview}>
        {(value) => (
          <>
            <span className="eyebrow">Team invitation</span>
            <h1>Join {value.teamDisplayName}</h1>
            <p>
              This invitation grants the {value.role} role and expires {formatDate(value.expiresAt)}.
            </p>
            <button className="button" type="button" onClick={join}>
              Join Team
            </button>
          </>
        )}
      </AsyncState>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </main>
  );
}

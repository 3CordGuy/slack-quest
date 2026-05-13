-- Job Board claim ledger.
--
-- Each posted job on the board can be taken by AT MOST ONE player per
-- posting cycle. Once claimed, the job shows "taken by @user" on the
-- board and the Take button is disabled — players who want that flavor
-- have to be first, otherwise fall back to `/sq quest <variant>` or
-- wait for the next daily refresh.
--
-- `refresh_stamp` ties a claim to a specific posting (the town_state's
-- `refreshed_at` ms timestamp). Daily refresh changes refresh_stamp →
-- claims for the prior stamp become orphaned but harmless; the new
-- jobs start with a fresh slate.
--
-- Atomic claim is INSERT OR IGNORE on the composite primary key — if
-- two players click "Take Job" at the same instant, exactly one INSERT
-- succeeds (returns changes=1); the other gets changes=0 and we refuse
-- the second claim.

CREATE TABLE job_claims (
  channel_id TEXT NOT NULL,
  refresh_stamp INTEGER NOT NULL,   -- matches town_state.refreshed_at for the posting
  job_id TEXT NOT NULL,             -- "job_1", "job_2", "job_3"
  taken_by TEXT NOT NULL,           -- slack_user_id of the claimant
  taken_at INTEGER NOT NULL,        -- ms timestamp; for tie-break + audit
  PRIMARY KEY (channel_id, refresh_stamp, job_id)
);

-- Tables of one tenant (plan sections 6.6 and 9). This file is applied once to every tenant schema, with the schema as
-- the only entry of the search path: the names below are therefore not qualified. A tenant schema holds nothing that
-- belongs to another tenant, so a forgotten tenant filter cannot reach another tenant's rows.
-- Amounts are credits = EUR cents, one positive integer from 1 to 1 000 000 (the provider's own bounds).
-- Idempotency keys: the same user and key give the same resource. Constraints are the last guard (DM-10).

CREATE TABLE deposits (
    id                  uuid        PRIMARY KEY,
    user_id             text        NOT NULL CONSTRAINT deposits_user_id_length CHECK (char_length(user_id) BETWEEN 1 AND 255),
    amount              integer     NOT NULL CONSTRAINT deposits_amount_range CHECK (amount BETWEEN 1 AND 1000000),
    status              text        NOT NULL DEFAULT 'pending' CONSTRAINT deposits_status_values CHECK (status IN ('pending', 'succeeded', 'failed')),
    idempotency_key     text        NOT NULL CONSTRAINT deposits_idempotency_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,255}$'),
    -- Digest of the request body: the same key with another body is answered 409.
    request_hash        text        NOT NULL,
    -- The provider's checkout session; both stay null until the provider answered.
    provider_session_id text,
    checkout_url        text,
    failure_reason      text        CONSTRAINT deposits_failure_reason_values CHECK (failure_reason IN ('declined', 'expired', 'provider_unavailable')),
    -- Expiry job: a pending deposit is looked at from next_check_at on (first at expires_at, created + 30 minutes), and
    -- after a failed look at the retry time; check_attempts counts the failed looks.
    expires_at          timestamptz NOT NULL,
    check_attempts      integer     NOT NULL DEFAULT 0 CONSTRAINT deposits_check_attempts_positive CHECK (check_attempts >= 0),
    next_check_at       timestamptz,
    last_error          text,
    created_at          timestamptz NOT NULL,
    updated_at          timestamptz NOT NULL,
    completed_at        timestamptz,
    CONSTRAINT deposits_user_idempotency_key UNIQUE (user_id, idempotency_key),
    CONSTRAINT deposits_provider_session_key UNIQUE (provider_session_id),
    CONSTRAINT deposits_checkout_pair CHECK ((provider_session_id IS NULL) = (checkout_url IS NULL)),
    CONSTRAINT deposits_reason_iff_failed CHECK ((status = 'failed') = (failure_reason IS NOT NULL)),
    CONSTRAINT deposits_completed_iff_final CHECK ((status = 'pending') = (completed_at IS NULL)),
    CONSTRAINT deposits_check_iff_pending CHECK ((status = 'pending') = (next_check_at IS NOT NULL))
);

CREATE INDEX deposits_check_due_idx ON deposits (next_check_at) WHERE status = 'pending';

CREATE TABLE withdrawals (
    id                 uuid        PRIMARY KEY,
    user_id            text        NOT NULL CONSTRAINT withdrawals_user_id_length CHECK (char_length(user_id) BETWEEN 1 AND 255),
    amount             integer     NOT NULL CONSTRAINT withdrawals_amount_range CHECK (amount BETWEEN 1 AND 1000000),
    status             text        NOT NULL DEFAULT 'requested' CONSTRAINT withdrawals_status_values CHECK (status IN ('requested', 'debited', 'paid_out', 'rejected', 'failed', 'refunded')),
    idempotency_key    text        NOT NULL CONSTRAINT withdrawals_idempotency_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{1,255}$'),
    request_hash       text        NOT NULL,
    -- Why it was rejected (insufficient_credits, trading_unavailable) or why the payout failed (forced, declined,
    -- payout_lost); a refunded withdrawal keeps the reason of its failure.
    reason             text        CONSTRAINT withdrawals_reason_values CHECK (reason IN ('insufficient_credits', 'trading_unavailable', 'forced', 'declined', 'payout_lost')),
    provider_payout_id text,
    -- Debit job (status requested): debit calls without a definitive answer, and when the job tries next.
    debit_attempts     integer     NOT NULL DEFAULT 0 CONSTRAINT withdrawals_debit_attempts_positive CHECK (debit_attempts >= 0),
    next_debit_at      timestamptz,
    -- Payout job (status debited): payout steps that did not finish, and when the job continues (also while the payout
    -- is created and waits for the provider to settle it).
    payout_attempts    integer     NOT NULL DEFAULT 0 CONSTRAINT withdrawals_payout_attempts_positive CHECK (payout_attempts >= 0),
    next_payout_at     timestamptz,
    -- Set in the transaction that claims the payout, before the provider is called: from then on a create may have
    -- reached the provider, so the force-payout-failure flag no longer applies to this withdrawal.
    payout_requested_at timestamptz,
    last_error         text,
    created_at         timestamptz NOT NULL,
    updated_at         timestamptz NOT NULL,
    completed_at       timestamptz,
    CONSTRAINT withdrawals_user_idempotency_key UNIQUE (user_id, idempotency_key),
    CONSTRAINT withdrawals_provider_payout_key UNIQUE (provider_payout_id),
    CONSTRAINT withdrawals_reason_matches_status CHECK (
        (status = 'rejected' AND reason IN ('insufficient_credits', 'trading_unavailable'))
        OR (status IN ('failed', 'refunded') AND reason IN ('forced', 'declined', 'payout_lost'))
        OR (status IN ('requested', 'debited', 'paid_out') AND reason IS NULL)
    ),
    -- A failed withdrawal is not final: it waits for the refund.
    CONSTRAINT withdrawals_completed_iff_final CHECK ((status IN ('paid_out', 'rejected', 'refunded')) = (completed_at IS NOT NULL)),
    CONSTRAINT withdrawals_debit_job_iff_requested CHECK ((status = 'requested') = (next_debit_at IS NOT NULL)),
    CONSTRAINT withdrawals_payout_job_iff_debited CHECK ((status = 'debited') = (next_payout_at IS NOT NULL)),
    -- No payout exists before the debit, and none for a rejected withdrawal.
    CONSTRAINT withdrawals_payout_after_debit CHECK (provider_payout_id IS NULL OR status IN ('debited', 'paid_out', 'failed', 'refunded')),
    CONSTRAINT withdrawals_requested_after_debit CHECK (payout_requested_at IS NULL OR status IN ('debited', 'paid_out', 'failed', 'refunded'))
);

CREATE INDEX withdrawals_debit_due_idx ON withdrawals (next_debit_at) WHERE status = 'requested';
CREATE INDEX withdrawals_payout_due_idx ON withdrawals (next_payout_at) WHERE status = 'debited';

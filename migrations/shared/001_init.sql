-- Shared schema of payments (plan sections 6.6 and 9): everything that no single tenant owns. The tables of the
-- tenants (deposits, withdrawals) are in migrations/tenant and exist once per tenant schema.
-- Ids are UUIDv7 made by the service; timestamps come from the service clock.
-- Constraints are the last guard (DM-10); foreign keys exist only inside this database (DM-02).
--
-- shared.schema_migrations (version, checksum, applied_at) is created by the migration runner itself, before the
-- first file runs, because it records which files ran; every tenant schema has its own copy of it.

CREATE SCHEMA IF NOT EXISTS shared;

-- The tenants this service has a schema for. A row is written in the same transaction that creates and migrates the
-- schema (the TenantCreated inbox), so a registered tenant always has its schema, and the startup migration applies
-- every tenant migration to every registered schema: schemas never drift apart.
CREATE TABLE shared.tenant_registry (
    tenant_id   uuid        PRIMARY KEY,
    schema_name text        NOT NULL CONSTRAINT tenant_registry_schema_format CHECK (schema_name ~ '^tenant_[0-9a-f]{32}$'),
    created_at  timestamptz NOT NULL,
    CONSTRAINT tenant_registry_schema_key UNIQUE (schema_name),
    -- The schema name is derived from the id and from nothing else.
    CONSTRAINT tenant_registry_schema_matches_id CHECK (schema_name = 'tenant_' || replace(tenant_id::text, '-', ''))
);

-- Transactional outbox (REL-01): written in the same transaction as the data change, published by the relay.
CREATE TABLE shared.outbox (
    id           uuid        PRIMARY KEY,
    aggregate_id text        NOT NULL,
    -- NATS subject, for example chance.payments.DepositSucceeded.<tenantId>.
    subject      text        NOT NULL,
    type         text        NOT NULL,
    -- The whole CloudEvent.
    payload      jsonb       NOT NULL,
    created_at   timestamptz NOT NULL,
    published_at timestamptz,
    attempts     integer     NOT NULL DEFAULT 0,
    last_error   text
);

CREATE INDEX outbox_unpublished_idx ON shared.outbox (created_at) WHERE published_at IS NULL;

-- Inbox of consumed events (ADR-053): the id of a processed event is stored in the same transaction as its change, so a
-- redelivered event changes nothing. One consumer per kind of event, because the same id never repeats across kinds.
CREATE TABLE shared.inbox (
    consumer     text        NOT NULL CONSTRAINT inbox_consumer_length CHECK (char_length(consumer) BETWEEN 1 AND 100),
    event_id     text        NOT NULL CONSTRAINT inbox_event_id_length CHECK (char_length(event_id) BETWEEN 1 AND 255),
    event_type   text        NOT NULL,
    processed_at timestamptz NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

CREATE INDEX inbox_processed_idx ON shared.inbox (processed_at);

-- Ids of the payment provider's webhooks that were processed (plan 6.6). The provider delivers at least once, so the id
-- is stored in the same transaction as the change the event led to.
CREATE TABLE shared.provider_events (
    event_id    text        PRIMARY KEY CONSTRAINT provider_events_id_length CHECK (char_length(event_id) BETWEEN 1 AND 255),
    event_type  text        NOT NULL,
    -- The checkout session or payout the event is about.
    object_id   text        NOT NULL,
    received_at timestamptz NOT NULL
);

CREATE INDEX provider_events_received_idx ON shared.provider_events (received_at);

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  employee_code TEXT NOT NULL UNIQUE,
  pin_hash TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'cleaner',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  avatar_url TEXT,
  source TEXT NOT NULL DEFAULT 'local',
  external_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_id TEXT;
ALTER TABLE users ALTER COLUMN pin_hash SET DEFAULT '';

CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  department TEXT,
  unit TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  employee_owner_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS employee_owner_id UUID REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_type_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_type_check
  CHECK (type IN ('group','direct','room','department','admin_employee'));
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_employee_owner
  ON conversations(employee_owner_id)
  WHERE employee_owner_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_role TEXT NOT NULL DEFAULT 'member',
  last_read_message_id UUID,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  body TEXT NOT NULL DEFAULT '',
  message_type TEXT NOT NULL DEFAULT 'text' CHECK (message_type IN ('text','image','video','audio','file','system')),
  reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  attachment_url TEXT,
  attachment_name TEXT,
  attachment_mime TEXT,
  attachment_size BIGINT,
  ai_processed BOOLEAN NOT NULL DEFAULT FALSE,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_created
  ON messages(conversation_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS ai_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  requester_id UUID REFERENCES users(id) ON DELETE SET NULL,
  unit TEXT,
  department TEXT,
  request_type TEXT,
  items JSONB NOT NULL DEFAULT '[]'::jsonb,
  priority TEXT NOT NULL DEFAULT 'Normal',
  summary TEXT NOT NULL,
  confidence NUMERIC(5,4),
  status TEXT NOT NULL DEFAULT 'pending',
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_actions_status_created
  ON ai_actions(status, created_at DESC);


CREATE TABLE IF NOT EXISTS message_reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_message_reactions_message
  ON message_reactions(message_id);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  subscription JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
  ON push_subscriptions(user_id);

ALTER TABLE conversation_members
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS client_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_client_id
  ON messages(client_id)
  WHERE client_id IS NOT NULL;

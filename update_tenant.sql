ALTER TABLE public.chat_sessions ADD COLUMN IF NOT EXISTS assigned_agent_id UUID;
ALTER TABLE public.chat_sessions ADD COLUMN IF NOT EXISTS internal_notes TEXT;

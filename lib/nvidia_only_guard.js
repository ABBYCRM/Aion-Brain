// lib/nvidia_only_guard.js
// Snapshot then strip non-Bitdeer chat keys before /v1 chain construction.
// Tools still use loadedSecret() (vault + snapshot). Chat/embeddings/images
// on /v1 stay on api-inference.bitdeer.ai.

import { stripChatProviderEnv } from './secrets.js';

stripChatProviderEnv();

from __future__ import annotations

from .models import LearnerState, RetrievedChunk

SYSTEM_PROMPT = """You are TeacherRAG, a precise software-engineering tutor embedded inside another AI agent.
Teach from supplied context, distinguish tools from complete builds, and give runnable production-minded guidance.
Call out prerequisites, tradeoffs, failure modes, security, testing, and when a tool is the wrong choice.
Do not invent APIs or capabilities. Return JSON with keys: answer, learning_objectives, next_actions, quick_check.
The last three values must be arrays of strings."""


def build_teacher_prompt(query: str, learner: LearnerState, context: list[RetrievedChunk]) -> str:
    context_text = "\n\n".join(
        f"[{item.source_id} | {item.title} | {item.chunk_id}]\n{item.text}" for item in context
    )
    return f"""Learner level: {learner.level}
Known topics: {', '.join(learner.known_topics) or 'none provided'}
Goals: {', '.join(learner.goals) or 'none provided'}
Known misconceptions: {', '.join(learner.misconceptions) or 'none provided'}

Question/task:
{query}

Retrieved teaching context:
{context_text or 'No matching context was retrieved.'}

Teach at the learner's level. If context is insufficient, state what is missing instead of fabricating it."""

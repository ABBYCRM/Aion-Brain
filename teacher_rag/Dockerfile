FROM python:3.12-slim
WORKDIR /app
COPY teacher_rag/pyproject.toml teacher_rag/README.md ./
COPY teacher_rag/src ./src
RUN pip install --no-cache-dir .
EXPOSE 8000
CMD ["uvicorn", "teacher_rag.api:app", "--host", "0.0.0.0", "--port", "8000"]

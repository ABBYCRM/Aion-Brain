from __future__ import annotations

from .models import SourceDocument


_CURRICULUM = [
    ("pandas", "Pandas", "Data analysis with DataFrames, cleaning, joins, grouping, time series, and tabular IO. A production analysis build still needs validated inputs, tests, reproducible environments, storage, orchestration, and monitoring."),
    ("beautifulsoup", "BeautifulSoup", "HTML parsing and static-page extraction. Use it after fetching HTML; for JavaScript-heavy interaction use a browser automation layer. Production scrapers need rate limits, retries, legal/robots review, selector resilience, and tests."),
    ("scikit-learn", "scikit-learn", "Classical machine learning for preprocessing, feature engineering, model training, evaluation, pipelines, and inference. Production ML also needs data/version control, monitoring, drift checks, deployment, and reproducibility."),
    ("opencv", "OpenCV", "Computer-vision primitives for image/video IO, transforms, feature extraction, geometry, and classical CV. Production systems also require model/runtime selection, performance profiling, input validation, and hardware-aware deployment."),
    ("pytorch", "PyTorch", "Tensor computation, automatic differentiation, neural-network training, and inference. Production deep learning additionally requires datasets, checkpoints, evaluation, serving, accelerator management, observability, and safety controls."),
    ("nltk", "NLTK", "NLP education and text-processing utilities such as tokenization, stemming, tagging, corpora, and linguistic analysis. Modern production NLP may instead use transformer libraries, hosted models, or specialized pipelines."),
    ("tensorflow", "TensorFlow", "Deep-learning training and inference ecosystem with tensors, Keras, data pipelines, export, and serving options. Production use requires model lifecycle, reproducibility, monitoring, security, and deployment engineering."),
    ("streamlit", "Streamlit", "Rapid Python UI development for data and ML applications. It is useful for dashboards and internal tools but does not replace production authentication, authorization, API design, persistence, observability, or scale planning."),
    ("fastapi", "FastAPI", "Python ASGI API framework with routing, validation, dependency injection, async support, and OpenAPI generation. A production API still needs authn/authz, persistence, migrations, rate limiting, logging, tracing, security headers, tests, deployment, and operations."),
    ("airflow", "Apache Airflow", "DAG-based orchestration for scheduled data and workflow pipelines. Production use requires idempotent tasks, retries, backfills, secrets, observability, resource limits, failure handling, and data-quality checks."),
    ("django", "Django", "Full-featured Python web framework with ORM, routing, forms, templates, authentication primitives, admin, and migrations. Production systems still need hardened configuration, authorization design, tests, caching, queues, deployment, and monitoring."),
    ("pyspark", "PySpark", "Python interface to Apache Spark for distributed data processing. Production systems require partitioning strategy, shuffle awareness, schema discipline, cluster sizing, job observability, retries, and cost controls."),
    ("flask", "Flask", "Minimal Python web framework for routing and request/response handling. Production applications need explicit choices for validation, auth, persistence, migrations, async/background work, tests, security, and deployment."),
    ("kivy", "Kivy", "Python framework for cross-platform graphical applications. Shipping an application additionally needs packaging, platform permissions, device testing, updates, crash reporting, accessibility, and distribution workflows."),
    ("numpy", "NumPy", "Foundational n-dimensional array and numerical-computing library. Strong use requires vectorization, broadcasting, dtype awareness, numerical stability, memory layout, testing, and profiling."),
    ("boto3", "Boto3", "AWS SDK for Python used to automate and operate AWS services. Production automation requires least-privilege IAM, retries, idempotency, pagination, region/account awareness, secret handling, audit logs, and failure recovery."),
    ("matplotlib", "Matplotlib", "Python plotting and visualization library. Reliable analytical output also needs validated data, clear labeling, accessible presentation, reproducible generation, and export/report pipelines."),
    ("langchain", "LangChain", "Framework components for LLM applications, retrieval, tools, agents, prompting, and orchestration. Production agents still require model/provider contracts, evaluation, tool security, state management, observability, retries, cost controls, and deterministic tests."),
    ("selenium", "Selenium", "Browser automation through WebDriver. Robust automation requires stable selectors, explicit waits, session cleanup, deterministic test data, browser/version management, retries only where justified, and flake diagnosis."),
    ("firecrawl-interact", "Firecrawl Scrape + Interact", "Use POST /v2/scrape to fetch clean content and obtain data.metadata.scrapeId, then POST /v2/scrape/{scrapeId}/interact with one focused prompt or code action. Code mode supports node, python, or bash with Playwright/agent-browser and timeout 1-300 seconds. Reuse the same scrapeId to preserve session state. Stop with DELETE /v2/scrape/{scrapeId}/interact so writable profiles persist and browser billing stops. Use profile on the initial scrape, not on interact. Responses can include output, stdout, result, stderr, exitCode, killed, cdpUrl, liveViewUrl, and interactiveLiveViewUrl."),
]


def load_python_ecosystem_curriculum() -> list[SourceDocument]:
    return [
        SourceDocument(
            source_id=source_id,
            title=title,
            content=content,
            metadata={"domain": "developer_skill", "difficulty": "beginner"},
        )
        for source_id, title, content in _CURRICULUM
    ]


def seed_curriculum(tutor) -> int:
    total = 0
    for document in load_python_ecosystem_curriculum():
        total += tutor.ingest(document)
    return total

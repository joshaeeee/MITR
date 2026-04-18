FROM python:3.11-slim

WORKDIR /app

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

COPY pyproject.toml /app/pyproject.toml
COPY src /app/src
COPY models /app/models

RUN pip install --no-cache-dir .

CMD ["python", "-m", "mitr_wakeword_worker"]

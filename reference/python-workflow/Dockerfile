FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    TORCH_HOME=/opt/models/torch

WORKDIR /app
COPY requirements-core.txt /app/requirements-core.txt
RUN python -m pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu torch==2.2.2 \
    && python -m pip install --no-cache-dir -r requirements-core.txt \
    && python -m pip install --no-cache-dir --no-deps simple-lama-inpainting==0.1.2

COPY . /app
RUN chmod +x /app/scripts/install_cpu.sh

# Mount a verified big-lama.pt and set LAMA_MODEL in production.
ENTRYPOINT ["python", "bulk_timestamp_pipeline.py"]


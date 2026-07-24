check_ollama_endpoint() {
  local label="$1"
  local url="$2"

  if [ -z "$url" ]; then
    echo "  $label Ollama endpoint not configured; skipping check"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "warning: curl not found; skipping $label endpoint check ($url)." >&2
    return 2
  fi

  if curl -fsS --max-time 3 "$url/api/tags" >/dev/null 2>&1; then
    echo "  $label Ollama endpoint reachable: $url"
    return 0
  fi

  echo "warning: $label Ollama endpoint not reachable: $url" >&2
  return 1
}

check_openai_compatible_endpoint() {
  local label="$1"
  local url="$2"

  if [ -z "$url" ]; then
    echo "  $label endpoint not configured; skipping check"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "warning: curl not found; skipping $label endpoint check ($url)." >&2
    return 2
  fi

  if curl -fsS --max-time 3 "$url/v1/models" >/dev/null 2>&1; then
    echo "  $label endpoint reachable: $url"
    return 0
  fi

  echo "warning: $label endpoint not reachable: $url" >&2
  return 1
}

check_llama_cpp_health_endpoint() {
  local label="$1"
  local url="$2"

  if [ -z "$url" ]; then
    echo "  $label llama.cpp health endpoint not configured; skipping check"
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "warning: curl not found; skipping $label health endpoint check ($url/health)." >&2
    return 2
  fi

  if curl -fsS --max-time 3 "$url/health" >/dev/null 2>&1; then
    echo "  $label llama.cpp health endpoint reachable: $url/health"
    return 0
  fi

  echo "warning: $label llama.cpp health endpoint not reachable: $url/health" >&2
  return 1
}

ollama_endpoint_reachable() {
  local url="$1"

  if [ -z "$url" ]; then
    return 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    return 2
  fi

  curl -fsS --max-time 3 "$url/api/tags" >/dev/null 2>&1
}

openai_compatible_endpoint_reachable() {
  local url="$1"

  if [ -z "$url" ]; then
    return 1
  fi

  if ! command -v curl >/dev/null 2>&1; then
    return 2
  fi

  curl -fsS --max-time 3 "${url%/}/v1/models" >/dev/null 2>&1
}
# ucodepen -- the app server plus static assets.
#
# Deliberately boring: python-slim, one pure-python dependency (pg8000, so no
# libpq build chain), one non-root process. The wasm runtime is prebuilt on
# the host (./build.sh) and copied in; the image never compiles C.

FROM python:3.12-slim

RUN pip install --no-cache-dir pg8000

WORKDIR /app
COPY server/ server/
COPY web/ web/

# web/ucode.wasm is a build artifact: fail loudly when it was forgotten.
RUN test -f web/ucode.wasm || (echo "web/ucode.wasm missing -- run ./build.sh before building the image" && exit 1)

RUN useradd --system --no-create-home ucodepen
USER ucodepen

ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080

CMD ["python3", "-m", "server"]
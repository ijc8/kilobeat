#!/bin/sh
# For HTTPS:
# gunicorn -k geventwebsocket.gunicorn.workers.GeventWebSocketWorker -w 1 --certfile cert.pem --keyfile key.pem -b 0.0.0.0:8765 server:app
# For running locally (perhaps with an HTTPS tunnel like ngrok):
gunicorn -k geventwebsocket.gunicorn.workers.GeventWebSocketWorker -w 1 server:app

#!/bin/sh
#gunicorn --worker-class eventlet -w 1 --certfile cert.pem --keyfile key.pem -b 0.0.0.0:8765 app:app
gunicorn --worker-class eventlet -w 1 -b localhost:8765 app:app

from flask import Flask, request, render_template, url_for
from flask_socketio import SocketIO, emit
import time

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
socketio = SocketIO(app)
player_count = 0

player_sid_map = {}
sid_player_map = {}
player_code = {}

start_time = time.time()

@app.route('/', defaults={'path': 'index.html'})
@app.route('/<path:path>')
def index(path):
    return app.send_static_file(path)

@socketio.on('connect')
def connect():
    global player_count
    print('connect', request.sid)
    emit('hello', {'id': player_count, 'players': player_code, 'time': time.time() - start_time})
    emit('join', player_count, broadcast=True, include_self=False)
    player_sid_map[player_count] = request.sid
    sid_player_map[request.sid] = player_count
    player_code[player_count] = '0'
    player_count += 1

@socketio.on('disconnect')
def disconnect():
    print('disconnect', request.sid)
    id = sid_player_map[request.sid]
    emit('leave', id, broadcast=True, include_self=False)
    del player_code[id]
    del player_sid_map[id]
    del sid_player_map[request.sid]

@socketio.on('code')
def handle_code(code):
    id = sid_player_map[request.sid]
    print('received code', code, 'from', id)
    player_code[id] = code
    emit('code', {'code': code, 'id': sid_player_map[request.sid]}, broadcast=True, include_self=False)

@socketio.on('reset')
def handle_reset():
    global start_time
    start_time = time.time()
    emit('reset', broadcast=True, include_self=True)

@socketio.on('editor')
def handle_editor(state):
    emit('editor', {'state': state, 'id': sid_player_map[request.sid]}, broadcast=True, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=8765)
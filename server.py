from flask import Flask, request, render_template, url_for, json
from flask_socketio import SocketIO, emit
import time


class Player:
    def __init__(self, id):
        self.id = id
        self.code = '0'
        self.speaker = {'x': 0, 'y': 0, 'angle': 0}


class CustomJSONEncoder(json.JSONEncoder):
    def default(self, o):
        if isinstance(o, Player):
            return o.__dict__
        return super().default(o)


app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret!'
app.json_encoder = CustomJSONEncoder
socketio = SocketIO(app, json=json, cors_allowed_origins='*')
player_count = 0

sid_map = {}
player_map = {}

start_time = time.time()

@app.route('/', defaults={'path': 'index.html'})
@app.route('/<path:path>')
def index(path):
    return app.send_static_file(path)

@socketio.on('connect')
def connect():
    global player_count
    id = player_count
    player_count += 1
    print('connect', request.sid)
    emit('hello', {'id': id, 'players': list(player_map.values()), 'time': time.time() - start_time})
    emit('join', id, broadcast=True, include_self=False)
    player = Player(id)
    player_map[id] = player
    sid_map[request.sid] = player

@socketio.on('disconnect')
def disconnect():
    print('disconnect', request.sid)
    id = sid_map[request.sid].id
    emit('leave', id, broadcast=True, include_self=False)
    del player_map[id]
    del sid_map[request.sid]

@socketio.on('code')
def handle_code(code):
    player = sid_map[request.sid]
    print('received code', code, 'from', player.id)
    player.code = code
    emit('code', {'state': code, 'id': player.id}, broadcast=True, include_self=False)

@socketio.on('reset')
def handle_reset():
    global start_time
    start_time = time.time()
    emit('reset', broadcast=True, include_self=True)

@socketio.on('editor')
def handle_editor(state):
    emit('editor', {'state': state, 'id': sid_map[request.sid].id}, broadcast=True, include_self=False)

@socketio.on('speaker')
def handle_speaker(state):
    player = sid_map[request.sid]
    player.speaker = state
    emit('speaker', {'state': state, 'id': player.id}, broadcast=True, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=8765)

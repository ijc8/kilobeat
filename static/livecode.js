/* global CodeMirror, AudioWorkletNode */

import { Scope } from "./Scope.js";

let audio;
let customNodes = {};
let codeViews = {};
let CustomAudioNode;
let analyser;
let processorCount = 0;

let socket = null;
let player_id = null;


const presets = [
  {
    name: "Silence",
    code: `0`
  },
  {
    name: "White Noise",
    code: `random() * 2 - 1`
  },
  {
    name: "Sine Wave",
    code: `sin(2 * pi * 666 * t)`
  }
];

function resumeContextOnInteraction(audioContext) {
  // from https://github.com/captbaritone/winamp2-js/blob/a5a76f554c369637431fe809d16f3f7e06a21969/js/media/index.js#L8-L27
  if (audioContext.state === "suspended") {
    const resume = async () => {
      await audioContext.resume();

      if (audioContext.state === "running") {
        document.body.removeEventListener("touchend", resume, false);
        document.body.removeEventListener("click", resume, false);
        document.body.removeEventListener("keydown", resume, false);
      }
    };

    document.body.addEventListener("touchend", resume, false);
    document.body.addEventListener("click", resume, false);
    document.body.addEventListener("keydown", resume, false);
  }
}

function stopAudio(id) {
  if (customNodes[id] !== undefined) {
    customNodes[id].disconnect();
    customNodes[id] = undefined;
  }
}

function getCode(userCode, processorName) {
  return `
  let t = 0;
  let pi = Math.PI;
  let sin = Math.sin;
  let random = Math.random;

  function loop(numFrames, out, sampleRate) {
    const amp = 0.1;
    for (let i = 0; i < numFrames; i++) {
      //const noise = Math.random() * 2 - 1;
      let val = ${userCode};
      out[i] = val * amp;
      t += 1 / sampleRate;
    }
  }

  class CustomProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
    }

    process(inputs, outputs, parameters) {
      const out = outputs[0][0];
      const numFrames = out.length;

      loop(numFrames, out, sampleRate);

      return true;
    }
  }

  registerProcessor("${processorName}", CustomProcessor);`;
}

function runAudioWorklet(id, workletUrl, processorName) {
  audio.audioWorklet.addModule(workletUrl).then(() => {
    stopAudio(id);

    let customNode = new CustomAudioNode(audio, processorName);

    customNode.connect(audio.destination);
    customNode.connect(analyser);
    customNodes[id] = customNode;
  });
}

function createButton(text) {
  const button = document.createElement("button");
  button.textContent = text;

  const onMouseUp = () => {
    button.classList.remove("down");
    document.removeEventListener("mouseup", onMouseUp, false);
  };

  const onMouseDown = () => {
    button.classList.add("down");
    document.addEventListener("mouseup", onMouseUp, false);
  };

  button.addEventListener("mousedown", onMouseDown);

  return button;
}

function addKeyCommandToButton(button, keyCommand) {
  keyCommand.split("-").forEach(key => {
    const el = document.createElement("kbd");
    el.classList.add("key");
    el.textContent = key.toLowerCase();
    button.appendChild(el);
  });
}

function runCode(id, userCode) {
  const processorName = `processor-${id}-${processorCount++}`;
  const code = getCode(userCode, processorName);
  const blob = new Blob([code], { type: "application/javascript" });
  const url = window.URL.createObjectURL(blob);

  console.log("runCode", id, userCode, processorName);
  runAudioWorklet(id, url, processorName);
}

function createEditor() {
  const isMac = CodeMirror.keyMap.default === CodeMirror.keyMap.macDefault;

  const runKeys = isMac ? "Cmd-Enter" : "Ctrl-Enter";
  const runButton = createButton("Run: ");
  runButton.classList.add("run");
  addKeyCommandToButton(runButton, runKeys);

  function runEditorCode(editor) {
    const userCode = editor.getDoc().getValue();
    socket.emit("code", userCode);
    runCode(player_id, userCode);
  }

  function playAudio(editor) {
    runEditorCode(editor);
  }

  // code mirror
  const editorWrap = document.getElementById("editor");
  if (editorWrap === null) { return; }
  const editor = CodeMirror(editorWrap, {
    mode: "javascript",
    value: presets[0].code,
    lineNumbers: false,
    lint: { esversion: 6 },
    viewportMargin: Infinity,
    tabSize: 2,
    scrollbarStyle: null
  });

  document.addEventListener("keydown", event => {
    const isModDown = isMac ? event.metaKey : event.ctrlKey;

    if (!isModDown) { return; }

    const isEnter = event.code === "Enter";
    const isPeriod = event.code === "Period";

    if (isEnter || isPeriod) { event.preventDefault(); }

    if (isEnter)  {
      playAudio(editor);
      runButton.classList.add("down");
      setTimeout(() => {
        if (runButton.classList.contains("down")) {
          runButton.classList.remove("down");
        }
      }, 200);
    }
  });

  const controlsEl = document.getElementById("controls");
  if (controlsEl !== null) {
    controlsEl.appendChild(runButton);
    runButton.addEventListener("click", () => playAudio(editor));

    presets.forEach(preset => {
      const button = createButton(preset.name);
      button.addEventListener("click", () => editor.getDoc().setValue(preset.code));
      const presetsEl = document.getElementById("presets");
      if (presetsEl !== null) { presetsEl.appendChild(button); }
    });
  }
}

function createViewer(id, code) {
  let parent = document.getElementById("main");
  let child = document.createElement('div');
  child.id = `p${id}-container`
  child.innerHTML = `Player ${id}`;
  let view = document.createElement('div');
  view.id = `p${id}-code`;
  view.value = code;
  const editor = CodeMirror(view, {
    mode: "javascript",
    value: code,
    lineNumbers: false,
    lint: { esversion: 6 },
    viewportMargin: Infinity,
    tabSize: 2,
    readOnly: true,
    scrollbarStyle: null,
  });
  codeViews[id] = editor;
  child.appendChild(view);
  parent.appendChild(child);
};

function createScopes() {
  const scopesContainer = document.getElementById("scopes");
  if (scopesContainer === null) { return; }

  analyser = audio.createAnalyser();
  window.analyser = analyser;
  analyser.fftSize = Math.pow(2, 11);
  analyser.minDecibels = -96;
  analyser.maxDecibels = 0;
  analyser.smoothingTimeConstant = 0.85;

  const scopeOsc = new Scope();

  const toRender = [
    {
      label: "Sum",
      analyser: analyser,
      style: "rgb(212, 100, 100)",
      edgeThreshold: 0.09,
      active: true
    }
  ];

  scopeOsc.appendTo(scopesContainer);

  //const scopeSpectrum = new Scope();
  //scopeSpectrum.appendTo(scopesContainer);


  function loop() {
    scopeOsc.renderScope(toRender.filter(item => item.active));

    // scopeSpectrum.renderSpectrum(analyser);
    requestAnimationFrame(loop);
  }

  loop();
}

function main() {

  socket = io();
  socket.on('connect', function() {
      console.log("connected!");
      socket.on('hello', ({id, players}) => {
        console.log('hello: I am', id, 'and there are', players);
        player_id = id;
        document.getElementById("status").innerHTML = `You are player ${id}.`
        for (let [player, code] of Object.entries(players)) {
          createViewer(player, code);
          runCode(player, code);
        }
      })

      socket.on('join', (id) => {
        console.log('join', id)
        createViewer(id, "0");
      });

      socket.on('leave', (id) => {
        console.log('leave', id)
        stopAudio(id);
        document.getElementById(`p${id}-container`).remove();
        delete codeViews[id];
      });

      socket.on('code', ({id, code}) => {
        codeViews[id].getDoc().setValue(code);
        runCode(id, code);
      })
  });

  if (window.AudioContext !== undefined && window.AudioWorkletNode !== undefined) {
    const unsupportedEl = document.getElementById("unsupported");
    if (unsupportedEl !== null) { unsupportedEl.remove(); }

    CustomAudioNode = class CustomAudioNode extends AudioWorkletNode {
      constructor(audioContext, processorName) {
        super(audioContext, processorName, {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1]
        });
      }
    };

    audio = new AudioContext();
    resumeContextOnInteraction(audio);

    createScopes();

    createEditor();
  }
}

function ready(fn) {
  if (document.attachEvent ? document.readyState === "complete" : document.readyState !== "loading"){
    fn();
  } else {
    document.addEventListener("DOMContentLoaded", fn);
  }
}

ready(main);

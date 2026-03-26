import { GameManager } from './managers/GameManager';
import { LoginScreen } from './ui/LoginScreen';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;

let game: GameManager | null = null;
let loginScreen: LoginScreen | null = null;

function startGame(token: string, username: string) {
  canvas.style.display = 'block';

  if (loginScreen) {
    loginScreen.destroy();
    loginScreen = null;
  }

  game = new GameManager(canvas, token, username, () => {
    handleDisconnect();
  });
}

function handleDisconnect() {
  if (game) {
    game.destroy();
    game = null;
  }
  // Clear stored session so we don't auto-login with a dead token
  localStorage.removeItem('projectrs_token');
  localStorage.removeItem('projectrs_username');
  showLoginScreen();
}

function showLoginScreen() {
  canvas.style.display = 'none';
  loginScreen = new LoginScreen((token, username) => {
    startGame(token, username);
  });
}

// Check for existing session — validate token before auto-login
const savedToken = localStorage.getItem('projectrs_token');
const savedUsername = localStorage.getItem('projectrs_username');

if (savedToken && savedUsername) {
  // Validate the token is still good before auto-connecting
  fetch('/api/validate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: savedToken }),
  }).then(res => res.json()).then(data => {
    if (data.ok) {
      startGame(savedToken, savedUsername);
    } else {
      localStorage.removeItem('projectrs_token');
      localStorage.removeItem('projectrs_username');
      showLoginScreen();
    }
  }).catch(() => {
    // Server unreachable or no validate endpoint — clear and show login
    localStorage.removeItem('projectrs_token');
    localStorage.removeItem('projectrs_username');
    showLoginScreen();
  });
} else {
  showLoginScreen();
}

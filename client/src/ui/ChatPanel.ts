export type ChatSendCallback = (message: string) => void;

export class ChatPanel {
  private container: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLInputElement;
  private onSend: ChatSendCallback | null = null;

  constructor() {
    this.container = this.buildUI();
    this.log = this.container.querySelector('#chat-log') as HTMLDivElement;
    this.input = this.container.querySelector('#chat-input') as HTMLInputElement;
    document.body.appendChild(this.container);

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const msg = this.input.value.trim();
        if (msg) {
          this.onSend?.(msg);
          this.input.value = '';
        }
        // Unfocus after sending so keys go back to game
        this.input.blur();
      }
      if (e.key === 'Escape') {
        this.input.blur();
      }
      // Prevent game input while typing
      e.stopPropagation();
    });

    // Global Enter key focuses chat input
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && document.activeElement !== this.input) {
        e.preventDefault();
        this.input.focus();
      }
    });

    // Focus input on click
    this.container.addEventListener('click', () => {
      this.input.focus();
    });
  }

  private buildUI(): HTMLDivElement {
    const panel = document.createElement('div');
    panel.id = 'chat-panel';
    panel.style.cssText = `
      position: fixed; bottom: 10px; left: 10px;
      width: 350px; height: 180px;
      background: rgba(0, 0, 0, 0.75);
      border: 2px solid #5a4a35; border-radius: 4px;
      display: flex; flex-direction: column;
      font-family: monospace; font-size: 13px;
      z-index: 100;
    `;

    // Chat log
    const log = document.createElement('div');
    log.id = 'chat-log';
    log.style.cssText = `
      flex: 1; overflow-y: auto; padding: 6px;
      color: #ddd; line-height: 1.4;
    `;
    panel.appendChild(log);

    // Input
    const inputBar = document.createElement('div');
    inputBar.style.cssText = `
      border-top: 1px solid #5a4a35; padding: 4px;
      display: flex; align-items: center;
    `;

    const input = document.createElement('input');
    input.id = 'chat-input';
    input.type = 'text';
    input.placeholder = 'Press Enter to chat...';
    input.maxLength = 200;
    input.style.cssText = `
      flex: 1; background: rgba(0, 0, 0, 0.5);
      border: 1px solid #3a3025; color: #fff;
      font-family: monospace; font-size: 13px;
      padding: 4px 8px; outline: none;
      border-radius: 2px;
    `;

    inputBar.appendChild(input);
    panel.appendChild(inputBar);

    return panel;
  }

  addMessage(from: string, message: string, color: string = '#ddd'): void {
    const el = document.createElement('div');
    el.innerHTML = `<span style="color: ${color}; font-weight: bold;">${this.escapeHtml(from)}:</span> ${this.escapeHtml(message)}`;
    this.log.appendChild(el);
    this.log.scrollTop = this.log.scrollHeight;
  }

  addSystemMessage(message: string, color: string = '#ff0'): void {
    const el = document.createElement('div');
    el.innerHTML = `<span style="color: ${color};">${this.escapeHtml(message)}</span>`;
    this.log.appendChild(el);
    this.log.scrollTop = this.log.scrollHeight;
  }

  setSendHandler(handler: ChatSendCallback): void {
    this.onSend = handler;
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

import * as vscode from 'vscode';
import { ChatMessage, listModelIds, streamChat } from './api';

const KEY_NAME = 'acedatacloud.modelProvider.apiKey';
const MODELS_NAME = 'acedatacloud.modelProvider.models';

interface SavedModel {
  id: string;
  maxInputTokens: number;
  maxOutputTokens: number;
  toolCalling: boolean;
  imageInput: boolean;
}

const FIRST_MODEL: SavedModel = {
  id: 'gpt-4.1-mini',
  maxInputTokens: 16384,
  maxOutputTokens: 4096,
  toolCalling: true,
  imageInput: false
};

function textFromPart(part: unknown): string {
  if (part instanceof vscode.LanguageModelTextPart) { return part.value; }
  if (part instanceof vscode.LanguageModelDataPart) {
    if (part.mimeType === 'application/json' || part.mimeType.startsWith('text/')) {
      return new TextDecoder().decode(part.data);
    }
    throw new Error(`Unsupported tool result type: ${part.mimeType}`);
  }
  if (part instanceof vscode.LanguageModelPromptTsxPart) { return JSON.stringify(part.value); }
  throw new Error('Unsupported tool result content.');
}

function toChatMessages(messages: readonly vscode.LanguageModelChatRequestMessage[], imageInput: boolean): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const message of messages) {
    const text: string[] = [];
    const images: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
    const calls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
    const toolResults: ChatMessage[] = [];
    for (const part of message.content) {
      if (part instanceof vscode.LanguageModelTextPart) { text.push(part.value); }
      else if (part instanceof vscode.LanguageModelToolCallPart) {
        if (message.role !== vscode.LanguageModelChatMessageRole.Assistant) { throw new Error('A tool call must be in an assistant message.'); }
        calls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input) } });
      } else if (part instanceof vscode.LanguageModelToolResultPart) {
        if (message.role !== vscode.LanguageModelChatMessageRole.User) { throw new Error('A tool result must be in a user message.'); }
        toolResults.push({ role: 'tool', tool_call_id: part.callId, content: part.content.map(textFromPart).join('\n') });
      } else if (part instanceof vscode.LanguageModelDataPart) {
        if (!imageInput || message.role !== vscode.LanguageModelChatMessageRole.User || !['image/png', 'image/jpeg', 'image/webp'].includes(part.mimeType)) {
          throw new Error('This model does not accept the attached data.');
        }
        images.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}` } });
      } else { throw new Error('This message contains an unsupported content part.'); }
    }
    if (message.role === vscode.LanguageModelChatMessageRole.Assistant) {
      if (text.length || calls.length) { result.push({ role: 'assistant', content: text.join('') || null, ...(calls.length ? { tool_calls: calls } : {}) }); }
    } else if (message.role === vscode.LanguageModelChatMessageRole.User) {
      result.push(...toolResults);
      if (text.length || images.length) {
        const content = images.length ? [...text.map(value => ({ type: 'text' as const, text: value })), ...images] : text.join('');
        result.push({ role: 'user', content });
      }
    } else if ((message.role as number) === 3) {
      // VS Code Agent sends system instructions with role 3 before this role is exposed in vscode.d.ts.
      if (calls.length || toolResults.length || images.length) { throw new Error('Unsupported system message content.'); }
      if (text.length) { result.push({ role: 'system', content: text.join('') }); }
    } else { throw new Error(`Unsupported chat message role ${String(message.role)}.`); }
  }
  if (!result.length) { throw new Error('A chat message is required.'); }
  return result;
}

export class AceChatProvider implements vscode.LanguageModelChatProvider {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeLanguageModelChatInformation = this.changed.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void { this.changed.dispose(); }

  private models(): SavedModel[] {
    const stored = this.context.globalState.get<SavedModel[]>(MODELS_NAME, []);
    return stored.filter(model => model && typeof model.id === 'string' &&
      Number.isInteger(model.maxInputTokens) && model.maxInputTokens > 0 &&
      Number.isInteger(model.maxOutputTokens) && model.maxOutputTokens > 0);
  }

  private async saveModels(models: SavedModel[]): Promise<void> {
    await this.context.globalState.update(MODELS_NAME, models);
    this.changed.fire();
  }

  private async apiKey(silent: boolean): Promise<string | undefined> {
    const saved = await this.context.secrets.get(KEY_NAME);
    if (saved || silent) { return saved; }
    await this.setApiKey();
    return this.context.secrets.get(KEY_NAME);
  }

  private async setApiKey(): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: 'Ace Data Cloud API key',
      prompt: 'Paste an application API key from Ace Data Cloud. This is a read-only validation step.',
      password: true,
      ignoreFocusOut: true,
      validateInput: value => value.trim() ? undefined : 'An API key is required.'
    });
    if (value === undefined) { return; }
    const key = value.trim();
    try {
      const ids = await listModelIds(key);
      await this.context.secrets.store(KEY_NAME, key);
      if (!this.models().length && ids.has(FIRST_MODEL.id)) { await this.saveModels([FIRST_MODEL]); }
      this.changed.fire();
      vscode.window.showInformationMessage('Ace Data Cloud API key saved. Choose an Ace Data Cloud model in Chat.');
    } catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unable to validate the API key.');
    }
  }

  private async addModel(): Promise<void> {
    const key = await this.apiKey(false);
    if (!key) { return; }
    let ids: Set<string>;
    try { ids = await listModelIds(key); }
    catch (error) {
      vscode.window.showErrorMessage(error instanceof Error ? error.message : 'Unable to load models.');
      return;
    }
    const id = await vscode.window.showInputBox({
      title: 'Add Ace Data Cloud chat model',
      prompt: 'Enter an exact chat-completions model ID from the Ace Data Cloud model catalog.',
      placeHolder: 'gpt-4.1-mini',
      ignoreFocusOut: true,
      validateInput: value => ids.has(value.trim()) ? undefined : 'This model ID is not in the current API catalog.'
    });
    if (!id) { return; }
    const input = await vscode.window.showInputBox({
      title: 'Input token limit',
      prompt: 'Choose a conservative limit within this model’s documented context window.',
      value: '16384',
      ignoreFocusOut: true,
      validateInput: value => Number.isInteger(Number(value)) && Number(value) > 0 ? undefined : 'Enter a positive integer.'
    });
    if (!input) { return; }
    const output = await vscode.window.showInputBox({
      title: 'Maximum output tokens',
      prompt: 'Choose a conservative cap; each request uses this as max_tokens.',
      value: '4096',
      ignoreFocusOut: true,
      validateInput: value => Number.isInteger(Number(value)) && Number(value) > 0 ? undefined : 'Enter a positive integer.'
    });
    if (!output) { return; }
    const capability = await vscode.window.showQuickPick([
      { label: 'Chat text only', toolCalling: false, imageInput: false },
      { label: 'Chat and agent tools', toolCalling: true, imageInput: false },
      { label: 'Chat, agent tools, and image input', toolCalling: true, imageInput: true }
    ], { title: 'Select only capabilities supported by this model', ignoreFocusOut: true });
    if (!capability) { return; }
    const model: SavedModel = {
      id: id.trim(), maxInputTokens: Number(input), maxOutputTokens: Number(output),
      toolCalling: capability.toolCalling, imageInput: capability.imageInput
    };
    await this.saveModels([...this.models().filter(existing => existing.id !== model.id), model]);
  }

  async manage(): Promise<void> {
    const choice = await vscode.window.showQuickPick([
      { label: 'Set or replace API key', id: 'key' },
      { label: 'Add or update chat model', id: 'add' },
      { label: 'Remove chat model', id: 'remove' },
      { label: 'Clear saved API key', id: 'clear' }
    ], { title: 'Ace Data Cloud Chat Models' });
    if (!choice) { return; }
    if (choice.id === 'key') { await this.setApiKey(); }
    else if (choice.id === 'add') { await this.addModel(); }
    else if (choice.id === 'remove') {
      const selected = await vscode.window.showQuickPick(this.models().map(model => model.id), { title: 'Remove Ace Data Cloud model' });
      if (selected) { await this.saveModels(this.models().filter(model => model.id !== selected)); }
    } else if (choice.id === 'clear') {
      await this.context.secrets.delete(KEY_NAME);
      this.changed.fire();
      vscode.window.showInformationMessage('Ace Data Cloud API key removed.');
    }
  }

  async provideLanguageModelChatInformation(options: vscode.PrepareLanguageModelChatModelOptions): Promise<vscode.LanguageModelChatInformation[]> {
    const key = await this.apiKey(options.silent);
    if (!key) { return []; }
    return this.models().map(model => ({
      id: model.id,
      name: model.id,
      family: model.id,
      version: '1',
      maxInputTokens: model.maxInputTokens,
      maxOutputTokens: model.maxOutputTokens,
      detail: 'Ace Data Cloud',
      tooltip: 'Uses your Ace Data Cloud API key and current model pricing.',
      capabilities: { toolCalling: model.toolCalling, imageInput: model.imageInput }
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatRequestMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const selected = this.models().find(item => item.id === model.id);
    if (!selected) { throw new Error('This Ace Data Cloud model is no longer configured.'); }
    const key = await this.context.secrets.get(KEY_NAME);
    if (!key) { throw new Error('Set an Ace Data Cloud API key before using this model.'); }
    if (options.tools?.length && !selected.toolCalling) { throw new Error('Tool calling is not enabled for this model.'); }
    const controller = new AbortController();
    const disposable = token.onCancellationRequested(() => controller.abort());
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      await streamChat(key, {
        model: selected.id,
        messages: toChatMessages(messages, selected.imageInput),
        max_tokens: selected.maxOutputTokens,
        stream: true,
        ...(options.tools?.length ? {
          tools: options.tools.map(tool => ({
            type: 'function' as const,
            function: { name: tool.name, description: tool.description, parameters: tool.inputSchema ?? { type: 'object', properties: {} } }
          })),
          tool_choice: options.toolMode === vscode.LanguageModelChatToolMode.Required ? 'required' as const : 'auto' as const
        } : {})
      }, controller.signal,
      text => progress.report(new vscode.LanguageModelTextPart(text)),
      call => progress.report(new vscode.LanguageModelToolCallPart(call.id, call.name, call.input)));
    } catch (error) {
      if (controller.signal.aborted) { throw new Error('The request was cancelled or timed out. Check usage before retrying.'); }
      throw error;
    } finally {
      clearTimeout(timeout);
      disposable.dispose();
    }
  }

  async provideTokenCount(_model: vscode.LanguageModelChatInformation, text: string | vscode.LanguageModelChatRequestMessage): Promise<number> {
    if (typeof text === 'string') { return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4)); }
    let count = 8;
    for (const part of text.content) {
      if (part instanceof vscode.LanguageModelTextPart) { count += Math.ceil(Buffer.byteLength(part.value, 'utf8') / 4); }
      else if (part instanceof vscode.LanguageModelDataPart) { count += part.mimeType.startsWith('image/') ? 1024 : Math.ceil(part.data.length / 4); }
      else if (part instanceof vscode.LanguageModelToolCallPart) { count += Math.ceil(Buffer.byteLength(JSON.stringify(part.input), 'utf8') / 4) + 16; }
      else if (part instanceof vscode.LanguageModelToolResultPart) { count += Math.ceil(Buffer.byteLength(part.content.map(textFromPart).join('\n'), 'utf8') / 4) + 16; }
    }
    return Math.max(1, count);
  }
}

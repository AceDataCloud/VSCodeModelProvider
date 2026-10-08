import * as vscode from 'vscode';
import { AceChatProvider } from './provider';

export function activate(context: vscode.ExtensionContext): void {
  const provider = new AceChatProvider(context);
  context.subscriptions.push(
    provider,
    vscode.lm.registerLanguageModelChatProvider('acedatacloud', provider),
    vscode.commands.registerCommand('acedatacloud.models.manage', () => provider.manage())
  );
}

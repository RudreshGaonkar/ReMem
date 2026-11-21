import * as fs from 'fs';
import * as vscode from 'vscode';
import type { PreBootContextProvider } from '../context/preboot.js';

/**
 * Registers a VS Code chat participant if supported by the host environment,
 * injecting pre-boot architecture map context at the beginning of chat sessions.
 */
export function registerChatParticipant(provider: PreBootContextProvider, context: vscode.ExtensionContext, getRules: () => string): vscode.Disposable | null {
  try {
    // Check if vscode.chat is supported in the current VS Code API version
    if (typeof (vscode as any).chat?.createChatParticipant === 'function') {
      const participant = (vscode as any).chat.createChatParticipant(
        'cuttlehawk',
        async (
          request: any,
          _chatContext: any,
          responseStream: any,
          token: vscode.CancellationToken
        ) => {
          const preboot = getRules() + `\n\n${await provider.getPreBootSystemPrompt()}`;

          // If user asked a specific question in chat, answer using available LM
          if (request?.prompt && request.prompt.trim().length > 0) {
            try {
              const models = await (vscode as any).lm?.selectChatModels?.();
              if (models && models.length > 0) {
                const model = models[0];
                const prompt = `${preboot}\n\nUser Question:\n${request.prompt}`;
                const messages = [(vscode as any).LanguageModelChatMessage.User(prompt)];
                const chatResponse = await model.sendRequest(messages, {}, token);
                for await (const fragment of chatResponse.text) {
                  responseStream.markdown(fragment);
                }
                return { metadata: { prebootContext: preboot } };
              }
            } catch {
              // Fall back to streaming preboot overview
            }
          }

          // Default output: show confirmation and pre-boot architecture map
          responseStream.markdown(`*(Cuttlehawk Knowledge Graph & Architecture Map Pre-Boot Active)*\n\n`);
          responseStream.markdown(preboot);
          return { metadata: { prebootContext: preboot } };
        }
      );

      const iconFile = context.asAbsolutePath('icon.png');

      if (iconFile && fs.existsSync(iconFile)) {
        participant.iconPath = vscode.Uri.file(iconFile);
      }

      context.subscriptions.push(participant);
      return participant;
    }
  } catch {
    // Non-fatal if chat participant API is unavailable
  }
  return null;
}

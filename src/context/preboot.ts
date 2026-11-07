import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { KnowledgeGraphEngine } from './graph.js';
import { WorkspaceIsolationManager } from '../core/workspace.js';

export const PREBOOT_AI_INSTRUCTION =
  'You have received the project architecture map. Do not run commands to scan or analyze the workspace files. Rely strictly on this map and the local Orama search.';

export const CHAIN_OF_THOUGHT_RULE = `
**CRITICAL EXECUTION RULE: PLAN BEFORE YOU CODE**
You are strictly forbidden from generating any code blocks immediately. 
Before you write or modify any file, you MUST output a brief <thinking> block. 
Inside this block, quickly analyze the project architecture map, identify existing utilities you can reuse, and state exactly what lines you need to change. 
Only after writing this plan are you allowed to output the actual code.
`.trim();

/**
 * Pre-Boot Context Provider
 *
 * Injects the contents of `.remem_context_feed.md` into the AI coding agent's system prompt
 * at chat boot / session start, together with the strict directive not to scan the workspace.
 */
export class PreBootContextProvider {
  private workspaceRoot: string;
  private graphEngine?: KnowledgeGraphEngine;

  constructor(workspaceRoot: string, graphEngine?: KnowledgeGraphEngine) {
    this.workspaceRoot = workspaceRoot;
    this.graphEngine = graphEngine;
  }

  /**
   * Generates the complete pre-boot system prompt context injection block.
   */
  public async getPreBootSystemPrompt(): Promise<string> {
    const feedContent = await this.loadContextFeed();

    const sections: string[] = [];
    sections.push('## 🗺️ PRE-BOOT PROJECT ARCHITECTURE MAP (ReMem Graph Engine)');
    sections.push(`> **MANDATORY DIRECTIVE:** ${PREBOOT_AI_INSTRUCTION}`);
    sections.push('');
    sections.push(CHAIN_OF_THOUGHT_RULE);
    sections.push('');
    sections.push(feedContent.trim());

    return sections.join('\n');
  }

  /**
   * Loads the current .remem_context_feed.md from the isolated workspace root.
   */
  private async loadContextFeed(): Promise<string> {
    const isolation = WorkspaceIsolationManager.getInstance();
    const feedPath = isolation ? isolation.contextFeedPath : path.join(this.workspaceRoot, '.remem_context_feed.md');

    try {
      if (fs.existsSync(feedPath)) {
        const content = await fs.promises.readFile(feedPath, 'utf8');
        if (content && content.trim().length > 0) {
          return content;
        }
      }
    } catch {
      // Fall through to generation
    }

    if (this.graphEngine) {
      const generated = await this.graphEngine.updateContextFeedSilently();
      if (generated && generated.trim().length > 0) {
        return generated;
      }
    }

    return '# Project Architecture Map not yet generated. Trigger ReMem Re-index.';
  }

  /**
   * Registers a VS Code chat participant if supported by the host environment,
   * injecting pre-boot architecture map context at the beginning of chat sessions.
   */
  public registerChatParticipant(context: vscode.ExtensionContext): vscode.Disposable | null {
    try {
      // Check if vscode.chat is supported in the current VS Code API version
      if (typeof (vscode as any).chat?.createChatParticipant === 'function') {
        const participant = (vscode as any).chat.createChatParticipant(
          'remem',
          async (
            request: any,
            _chatContext: any,
            responseStream: any,
            token: vscode.CancellationToken
          ) => {
            const preboot = await this.getPreBootSystemPrompt();

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
            responseStream.markdown(`*(ReMem Knowledge Graph & Architecture Map Pre-Boot Active)*\n\n`);
            responseStream.markdown(preboot);
            return { metadata: { prebootContext: preboot } };
          }
        );

        const iconFile = fs.existsSync(path.join(this.workspaceRoot, 'icon.png'))
          ? path.join(this.workspaceRoot, 'icon.png')
          : (typeof context.asAbsolutePath === 'function' ? context.asAbsolutePath('icon.png') : undefined);

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
}
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
        return await fs.promises.readFile(feedPath, 'utf8');
      }
    } catch {
      // Fall through to generation
    }

    if (this.graphEngine) {
      return await this.graphEngine.updateContextFeedSilently();
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
            _request: any,
            _chatContext: any,
            responseStream: any,
            _token: vscode.CancellationToken
          ) => {
            const preboot = await this.getPreBootSystemPrompt();
            responseStream.markdown(`*(ReMem Knowledge Graph & Architecture Map Pre-Boot Active)*\n\n`);
            // Response stream hook for AI participants
            return { metadata: { prebootContext: preboot } };
          }
        );

        participant.iconPath = vscode.Uri.file(path.join(this.workspaceRoot, 'icon.png'));
        context.subscriptions.push(participant);
        return participant;
      }
    } catch {
      // Non-fatal if chat participant API is unavailable
    }
    return null;
  }
}
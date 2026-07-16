/**
 * ZAO - Lightweight Markdown Renderer
 *
 * Deliberately NOT using react-native-markdown-display or similar - after
 * everything it took to stabilize the Gradle/Kotlin build, adding another
 * dependency (even a pure-JS one can have transitive native deps) isn't
 * worth it for what's actually needed here: bold, italic, inline code,
 * and fenced code blocks. That covers the overwhelming majority of what
 * AI models actually produce in chat responses.
 *
 * This is intentionally NOT a full CommonMark parser - no tables, no nested
 * lists with indentation tracking, no link parsing. If model output starts
 * regularly using markdown features this doesn't handle, that's a signal to
 * revisit (possibly with a real dependency at that point), not a reason to
 * over-build this now.
 */

import React, { useState } from 'react';
import { Text, View, StyleSheet, Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';

/**
 * Parses a single line of text for inline markdown: **bold**, *italic*,
 * `inline code`. Returns an array of {text, bold, italic, code} segments.
 */
function parseInline(line) {
  const segments = [];
  // Order matters: bold (**) must be checked before italic (*) since **x**
  // would otherwise be misread as italic-wrapping-italic.
  const pattern = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(`(.+?)`)/g;
  let lastIndex = 0;
  let match;

  while ((match = pattern.exec(line)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: line.slice(lastIndex, match.index) });
    }
    if (match[1]) segments.push({ text: match[2], bold: true });
    else if (match[3]) segments.push({ text: match[4], italic: true });
    else if (match[5]) segments.push({ text: match[6], code: true });
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < line.length) {
    segments.push({ text: line.slice(lastIndex) });
  }
  return segments.length > 0 ? segments : [{ text: line }];
}

/**
 * A fenced code block with a small clipboard button in its top-right corner
 * so a single tap copies just that block's code, not the whole message.
 */
function CodeBlock({ content, codeBackground, codeTextColor, borderColor }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(content || '');
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <View style={[styles.codeBlock, { backgroundColor: codeBackground, borderColor }]}>
      <View style={styles.codeBlockHeader}>
        <Pressable
          onPress={handleCopy}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          style={({ pressed }) => [styles.codeCopyButton, pressed && { opacity: 0.5 }]}
        >
          <Ionicons
            name={copied ? 'checkmark' : 'copy-outline'}
            size={14}
            color={codeTextColor}
          />
        </Pressable>
      </View>
      <Text style={[styles.codeBlockText, { color: codeTextColor }]}>{content}</Text>
    </View>
  );
}

/**
 * Renders markdown content as a sequence of RN Text/View nodes, theme-aware.
 * Handles: fenced code blocks (```), headers (# ## ###), bullet lists
 * (- or *), numbered lists, and inline bold/italic/code.
 */
export default function MarkdownText({ content, textColor, codeBackground, codeTextColor, borderColor }) {
  if (!content) return null;

  const lines = content.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // skip closing ```
      blocks.push({ type: 'code', content: codeLines.join('\n') });
      continue;
    }

    // Headers
    const headerMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (headerMatch) {
      blocks.push({ type: 'header', level: headerMatch[1].length, content: headerMatch[2] });
      i += 1;
      continue;
    }

    // Bullet list item
    const bulletMatch = line.match(/^\s*[-*+]\s+(.*)/);
    if (bulletMatch) {
      blocks.push({ type: 'bullet', content: bulletMatch[1] });
      i += 1;
      continue;
    }

    // Numbered list item
    const numberedMatch = line.match(/^\s*(\d+)\.\s+(.*)/);
    if (numberedMatch) {
      blocks.push({ type: 'numbered', number: numberedMatch[1], content: numberedMatch[2] });
      i += 1;
      continue;
    }

    // Blank line - paragraph break
    if (line.trim() === '') {
      blocks.push({ type: 'break' });
      i += 1;
      continue;
    }

    blocks.push({ type: 'paragraph', content: line });
    i += 1;
  }

  const renderSegments = (text, baseStyle) => {
    const segments = parseInline(text);
    return segments.map((seg, idx) => (
      <Text
        key={idx}
        style={[
          baseStyle,
          seg.bold && styles.bold,
          seg.italic && styles.italic,
          seg.code && [styles.inlineCode, { backgroundColor: codeBackground, color: codeTextColor }],
        ]}
      >
        {seg.text}
      </Text>
    ));
  };

  return (
    <View>
      {blocks.map((block, idx) => {
        const baseStyle = { color: textColor, fontSize: 15, lineHeight: 21 };

        if (block.type === 'break') {
          return <View key={idx} style={{ height: 8 }} />;
        }
        if (block.type === 'code') {
          return (
            <CodeBlock
              key={idx}
              content={block.content}
              codeBackground={codeBackground}
              codeTextColor={codeTextColor}
              borderColor={borderColor}
            />
          );
        }
        if (block.type === 'header') {
          const sizes = { 1: 20, 2: 18, 3: 16 };
          return (
            <Text key={idx} style={[baseStyle, styles.bold, { fontSize: sizes[block.level], marginTop: 4, marginBottom: 2 }]}>
              {renderSegments(block.content, { color: textColor })}
            </Text>
          );
        }
        if (block.type === 'bullet') {
          return (
            <View key={idx} style={styles.listRow}>
              <Text style={[baseStyle, { marginRight: 6 }]}>•</Text>
              <Text style={[baseStyle, { flex: 1 }]}>{renderSegments(block.content, baseStyle)}</Text>
            </View>
          );
        }
        if (block.type === 'numbered') {
          return (
            <View key={idx} style={styles.listRow}>
              <Text style={[baseStyle, { marginRight: 6 }]}>{block.number}.</Text>
              <Text style={[baseStyle, { flex: 1 }]}>{renderSegments(block.content, baseStyle)}</Text>
            </View>
          );
        }
        // paragraph
        return (
          <Text key={idx} style={baseStyle}>
            {renderSegments(block.content, baseStyle)}
          </Text>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bold: {
    fontWeight: '700',
  },
  italic: {
    fontStyle: 'italic',
  },
  inlineCode: {
    fontFamily: 'monospace',
    fontSize: 14,
    paddingHorizontal: 4,
    borderRadius: 4,
  },
  codeBlock: {
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingBottom: 10,
    marginVertical: 6,
  },
  codeBlockHeader: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    marginTop: 4,
  },
  codeCopyButton: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  codeBlockText: {
    fontFamily: 'monospace',
    fontSize: 13,
    lineHeight: 18,
  },
  listRow: {
    flexDirection: 'row',
    marginBottom: 2,
  },
});

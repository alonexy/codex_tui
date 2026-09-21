import test from 'node:test';
import assert from 'node:assert/strict';
import { fencedBlock } from '../public/mermaid.js';

test('only closed Mermaid fences can be rendered, preserving exact source', () => {
  assert.deepEqual(fencedBlock(['```Mermaid', 'flowchart TD', ' A --> B', '```', 'after'], 0),
    { language: 'mermaid', closed: true, end: 3, source: 'flowchart TD\n A --> B\n' });
  assert.equal(fencedBlock(['```mermaid', 'A --> B'], 0).closed, false);
  assert.equal(fencedBlock(['````mermaid', '```', 'still code', '````'], 0).source, '```\nstill code\n');
  assert.equal(fencedBlock(['  ~~~mermaid', 'A --> B', '~~~   '], 0).closed, true);
  assert.equal(fencedBlock(['```javascript', '```not a closing fence', '```'], 0).source, '```not a closing fence\n');
  assert.equal(fencedBlock(['not a fence'], 0), null);
});

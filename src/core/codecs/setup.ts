import { codecRegistry } from './CodecRegistry';
import { txtCodec } from './TxtCodec';
import { markdownCodec } from './MarkdownCodec';
import { docxCodec } from './DocxCodec';
import { htmlCodec } from './HtmlCodec';
import { odtCodec } from './OdtCodec';
import { rtfCodec } from './RtfCodec';
import { epubCodec } from './EpubCodec';

// Register all available codecs
codecRegistry.register(txtCodec);
codecRegistry.register(markdownCodec);
codecRegistry.register(docxCodec);
codecRegistry.register(htmlCodec);
codecRegistry.register(odtCodec);
codecRegistry.register(rtfCodec);
codecRegistry.register(epubCodec);

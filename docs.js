const fs = require('fs');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { getTenantPool } = require('./db');

// Helper: Call OpenAI Embeddings API
async function getEmbedding(text, openAiApiKey) {
  const apiKey = openAiApiKey || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OpenAI API key is missing. Cannot generate embeddings.');
  }

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      input: text,
      model: 'text-embedding-3-small'
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI Embeddings error: ${response.status} - ${errorText}`);
  }

  const result = await response.json();
  return result.data[0].embedding;
}

// Chunker: Split text into chunks of given size with overlap
function chunkText(text, chunkSize = 1000, overlap = 200) {
  // Normalize whitespaces
  const cleanText = text.replace(/\s+/g, ' ').trim();
  const chunks = [];
  let startIndex = 0;

  if (cleanText.length <= chunkSize) {
    return [cleanText];
  }

  while (startIndex < cleanText.length) {
    let endIndex = startIndex + chunkSize;
    
    // If this is not the end of the text, try to find a natural boundary (space or newline)
    if (endIndex < cleanText.length) {
      const lastSpace = cleanText.lastIndexOf(' ', endIndex);
      if (lastSpace > startIndex + (chunkSize / 2)) {
        endIndex = lastSpace; // Adjust to last space to avoid cutting words
      }
    } else {
      endIndex = cleanText.length;
    }

    const chunk = cleanText.substring(startIndex, endIndex).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    // Move start index back by overlap
    startIndex = endIndex - overlap;
    if (startIndex >= cleanText.length || endIndex === cleanText.length) {
      break;
    }
  }

  return chunks;
}

// Extract raw text from PDF
async function extractTextFromPdf(filePath) {
  const dataBuffer = fs.readFileSync(filePath);
  const pdfData = await pdfParse(dataBuffer);
  return pdfData.text;
}

// Extract raw text from DOCX
async function extractTextFromDocx(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value;
}

// Extract text from plain TXT
async function extractTextFromTxt(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

// Process file and save chunks into the vector database
async function ingestDocument(dbName, originalName, fileUrl, localFilePath, openAiApiKey) {
  console.log(`Ingesting document "${originalName}" for database ${dbName}...`);
  
  let rawText = '';
  const extension = originalName.split('.').pop().toLowerCase();

  try {
    if (extension === 'pdf') {
      rawText = await extractTextFromPdf(localFilePath);
    } else if (extension === 'docx') {
      rawText = await extractTextFromDocx(localFilePath);
    } else if (extension === 'txt') {
      rawText = await extractTextFromTxt(localFilePath);
    } else {
      throw new Error(`Unsupported file extension: .${extension}`);
    }

    if (!rawText || rawText.trim().length === 0) {
      throw new Error('Extracted text is empty.');
    }

    console.log(`Extracted ${rawText.length} characters of raw text. Generating chunks...`);
    const chunks = chunkText(rawText, 1000, 200);
    console.log(`Generated ${chunks.length} chunks. Vectorizing chunks with OpenAI...`);

    const tenantPool = getTenantPool(dbName);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = await getEmbedding(chunk, openAiApiKey);
      const vectorStr = `[${embedding.join(',')}]`;

      await tenantPool.query(
        `INSERT INTO public.kb_documents (file_name, file_url, chunk_content, embedding) 
         VALUES ($1, $2, $3, $4::vector)`,
        [originalName, fileUrl, chunk, vectorStr]
      );
      
      if ((i + 1) % 5 === 0 || i === chunks.length - 1) {
        console.log(`Vectorized & saved ${i + 1}/${chunks.length} chunks...`);
      }
    }

    console.log(`Document "${originalName}" fully ingested into ${dbName}.`);
  } catch (err) {
    console.error(`Error ingesting document "${originalName}":`, err);
    throw err;
  }
}

// Perform semantic search inside tenant database
async function searchVectorKb(dbName, queryText, openAiApiKey, limit = 4) {
  try {
    const embedding = await getEmbedding(queryText, openAiApiKey);
    const vectorStr = `[${embedding.join(',')}]`;
    const tenantPool = getTenantPool(dbName);
    
    const result = await tenantPool.query(
      `SELECT chunk_content, file_name, 1 - (embedding <=> $1::vector) as similarity
       FROM public.kb_documents
       ORDER BY embedding <=> $1::vector
       LIMIT $2`,
      [vectorStr, limit]
    );

    return result.rows;
  } catch (err) {
    console.error(`Error searching vector KB in ${dbName}:`, err);
    return [];
  }
}

module.exports = {
  ingestDocument,
  searchVectorKb,
  getEmbedding,
};

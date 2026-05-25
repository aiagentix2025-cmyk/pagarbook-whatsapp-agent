const fs = require('fs');
const path = require('path');

const pocketbaseHost = process.env.POCKETBASE_URL; // e.g. "http://127.0.0.1:8090" or "http://pocketbase:8090"

// Download image/media from Meta Graph API
async function downloadMetaMedia(mediaId, accessToken) {
  try {
    console.log(`Fetching media metadata for ID: ${mediaId}...`);
    const metadataUrl = `https://graph.facebook.com/v18.0/${mediaId}`;
    const metaRes = await fetch(metadataUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!metaRes.ok) {
      const errText = await metaRes.text();
      throw new Error(`Failed fetching media metadata: ${metaRes.status} - ${errText}`);
    }

    const metadata = await metaRes.json();
    const downloadUrl = metadata.url;
    const mimeType = metadata.mime_type;
    console.log(`Media URL retrieved: ${downloadUrl} (${mimeType})`);

    // Download the binary file
    const fileRes = await fetch(downloadUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    if (!fileRes.ok) {
      throw new Error(`Failed to download binary media from Meta: ${fileRes.status}`);
    }

    const arrayBuffer = await fileRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    
    return {
      buffer,
      mimeType,
      extension: mimeType.split('/')[1] || 'bin'
    };
  } catch (err) {
    console.error('Error downloading Meta media:', err);
    throw err;
  }
}

// Upload file to PocketBase, falling back to local storage if not configured
async function saveMedia(buffer, filename, mimeType) {
  const publicDir = path.join(__dirname, 'public', 'media');
  
  // Make sure directories exist
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  // Generate unique local file path
  const safeFilename = `${Date.now()}_${filename.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
  const localPath = path.join(publicDir, safeFilename);

  // Always save locally first as a fallback/record
  fs.writeFileSync(localPath, buffer);
  
  // Base local public URL (adjust port/host if needed)
  let publicUrl = `/media/${safeFilename}`;
  if (process.env.APP_URL) {
    publicUrl = `${process.env.APP_URL}/media/${safeFilename}`;
  } else {
    // Default fallback to VPS host ip URL
    publicUrl = `https://pagarbook-bot.76.13.250.173.sslip.io/media/${safeFilename}`;
  }

  // Attempt PocketBase upload if host is provided
  if (pocketbaseHost) {
    try {
      console.log(`Attempting to upload media to PocketBase at ${pocketbaseHost}...`);
      
      const formData = new FormData();
      // PocketBase file records need a file field
      const blob = new Blob([buffer], { type: mimeType });
      formData.append('file', blob, filename);
      formData.append('title', filename);

      const pbRes = await fetch(`${pocketbaseHost}/api/collections/whatsapp_media/records`, {
        method: 'POST',
        body: formData
      });

      if (pbRes.ok) {
        const pbRecord = await pbRes.json();
        // PocketBase files are accessed via: /api/files/:collectionIdOrName/:recordId/:filename
        publicUrl = `${pocketbaseHost}/api/files/${pbRecord.collectionId}/${pbRecord.id}/${pbRecord.file}`;
        console.log(`Media uploaded to PocketBase successfully: ${publicUrl}`);
      } else {
        const errText = await pbRes.text();
        console.warn(`PocketBase upload returned error, using local fallback: ${pbRes.status} - ${errText}`);
      }
    } catch (pbErr) {
      console.warn(`Failed uploading to PocketBase, using local fallback: ${pbErr.message}`);
    }
  }

  return publicUrl;
}

module.exports = {
  downloadMetaMedia,
  saveMedia
};

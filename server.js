// ==========================================
// 1. SETUP & INSTRUCTIONS
// ==========================================

 
  // create trigger on_auth_user_created after insert on auth.users
  // for each row execute procedure public.handle_new_user();
  
  // -- Storage: Create a bucket named 'drive' in Supabase Storage.
 

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Supabase (Use Service Role Key to bypass RLS in Node, we handle auth manually)
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ==========================================
// 2. AUTH MIDDLEWARE
// ==========================================
const requireAuth = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing token' });

  const token = authHeader.split(' ')[1];
  
  // Verify JWT via Supabase Auth
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  req.user = user;
  next();
};

// ==========================================
// 3. API ROUTES
// ==========================================

// HEALTH CHECK
app.get('/', (req, res) => res.send('Drive API Ready'));

/**
 * FOLDER ROUTES
 */

// Create Folder
app.post('/api/folders', requireAuth, async (req, res) => {
  const { name, parentId } = req.body;
  try {
    const { data, error } = await supabase
      .from('folders')
      .insert([{ 
        name, 
        parent_id: parentId || null, 
        owner_id: req.user.id 
      }])
      .select()
      .single();

    if (error) throw error;
    res.status(201).json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get Folder Content (Pass 'root' as ID for top level)
app.get('/api/folders/:id', requireAuth, async (req, res) => {
  const folderId = req.params.id === 'root' ? null : req.params.id;
  const userId = req.user.id;

  try {
    // 1. Get Subfolders
    let folderQuery = supabase
      .from('folders')
      .select('*')
      .eq('owner_id', userId)
      .eq('is_deleted', false);
    
    if (folderId) folderQuery = folderQuery.eq('parent_id', folderId);
    else folderQuery = folderQuery.is('parent_id', null);

    const { data: folders, error: folderErr } = await folderQuery;
    if (folderErr) throw folderErr;

    // 2. Get Files
    let fileQuery = supabase
      .from('files')
      .select('*')
      .eq('owner_id', userId)
      .eq('is_deleted', false);
      
    if (folderId) fileQuery = fileQuery.eq('folder_id', folderId);
    else fileQuery = fileQuery.is('folder_id', null);

    const { data: files, error: fileErr } = await fileQuery;
    if (fileErr) throw fileErr;

    // 3. Get Current Folder Metadata
    let currentFolder = null;
    if (folderId) {
      const { data } = await supabase.from('folders').select('*').eq('id', folderId).single();
      currentFolder = data;
    }

    res.json({ folder: currentFolder, children: { folders, files } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * FILE ROUTES (Presigned URL Flow)
 */

// Step 1: Init Upload (Get Signed URL)
app.post('/api/files/init', requireAuth, async (req, res) => {
  const { name, folderId } = req.body;
  const fileId = uuidv4();
  // Storage Path: users/USER_ID/FILE_ID-NAME
  const storagePath = `users/${req.user.id}/${fileId}-${name}`;

  try {
    // Create signed upload URL (valid for upload)
    const { data, error } = await supabase.storage
      .from('drive')
      .createSignedUploadUrl(storagePath);

    if (error) throw error;

    res.json({
      fileId,
      storageKey: storagePath,
      uploadUrl: data.signedUrl, // Frontend PUTs file here
      token: data.token
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Step 2: Complete Upload (Save DB Record)
app.post('/api/files/complete', requireAuth, async (req, res) => {
  const { fileId, name, mimeType, sizeBytes, folderId, storageKey } = req.body;
  
  try {
    const { data, error } = await supabase
      .from('files')
      .insert([{
        id: fileId,
        name,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        storage_key: storageKey,
        folder_id: folderId || null,
        owner_id: req.user.id
      }])
      .select()
      .single();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Download File (Get Signed URL)
app.get('/api/files/:id', requireAuth, async (req, res) => {
  try {
    // Verify ownership
    const { data: file, error: dbErr } = await supabase
      .from('files')
      .select('*')
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id)
      .single();
    
    if (dbErr || !file) return res.status(404).json({ error: 'File not found' });

    // Generate URL valid for 60 seconds
    const { data } = await supabase.storage
      .from('drive')
      .createSignedUrl(file.storage_key, 60);

    res.json({ url: data.signedUrl, name: file.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete File
app.delete('/api/files/:id', requireAuth, async (req, res) => {
  try {
    // Soft delete
    const { error } = await supabase
      .from('files')
      .update({ is_deleted: true })
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * SEARCH ROUTE
 */
app.get('/api/search', requireAuth, async (req, res) => {
  const { q } = req.query;
  try {
    const { data, error } = await supabase
      .from('files')
      .select('*')
      .eq('owner_id', req.user.id)
      .eq('is_deleted', false)
      .ilike('name', `%${q}%`); // Simple case-insensitive match

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/**
 * SHARE ROUTES
 */
// Generate or Get Public Link
app.post('/api/files/:id/share', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if share exists
    let { data: share } = await supabase
      .from('shares')
      .select('*')
      .eq('file_id', id)
      .single();

    // If not, create one
    if (!share) {
      const { data, error } = await supabase
        .from('shares')
        .insert([{ file_id: id, is_public: true }])
        .select()
        .single();
      if (error) throw error;
      share = data;
    }

    // Return the public accessible URL (Frontend will handle the UI)
    res.json({ shareId: share.id, isPublic: share.is_public });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get File Content via Share ID (Public Access - No Auth Middleware)
app.get('/api/shared/:shareId', async (req, res) => {
  try {
    const { shareId } = req.params;

    // 1. Validate Share ID
    const { data: share, error: shareError } = await supabase
      .from('shares')
      .select('file_id')
      .eq('id', shareId)
      .eq('is_public', true)
      .single();

    if (shareError || !share) return res.status(404).json({ error: 'Link expired or invalid' });

    // 2. Get File Details
    const { data: file } = await supabase
      .from('files')
      .select('*')
      .eq('id', share.file_id)
      .single();

    // 3. Generate Signed URL (valid for 1 hour)
    const { data: signed } = await supabase.storage
      .from('drive')
      .createSignedUrl(file.storage_key, 3600);

    res.json({ ...file, url: signed.signedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


/**
 * TRASH ROUTES
 */
// Get Trash (Files + Folders)
app.get('/api/trash', requireAuth, async (req, res) => {
  try {
    // Get deleted folders
    const { data: folders } = await supabase
      .from('folders')
      .select('*')
      .eq('owner_id', req.user.id)
      .eq('is_deleted', true);

    // Get deleted files
    const { data: files } = await supabase
      .from('files')
      .select('*')
      .eq('owner_id', req.user.id)
      .eq('is_deleted', true);

    res.json({ folder: { name: 'Trash' }, children: { folders: folders || [], files: files || [] } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore Item
app.post('/api/trash/restore', requireAuth, async (req, res) => {
  const { id, type } = req.body; // type = 'file' or 'folder'
  const table = type === 'folder' ? 'folders' : 'files';
  
  try {
    const { error } = await supabase
      .from(table)
      .update({ is_deleted: false })
      .eq('id', id)
      .eq('owner_id', req.user.id);
      
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Permanent Delete
app.delete('/api/trash/:id', requireAuth, async (req, res) => {
  const { type } = req.query; // ?type=file or ?type=folder
  const table = type === 'folder' ? 'folders' : 'files';
  
  try {
    // For files, we should also remove from Storage bucket to save space
    if (type === 'file') {
      const { data: file } = await supabase.from('files').select('storage_key').eq('id', req.params.id).single();
      if (file) await supabase.storage.from('drive').remove([file.storage_key]);
    }

    const { error } = await supabase
      .from(table)
      .delete()
      .eq('id', req.params.id)
      .eq('owner_id', req.user.id);

    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * SHARED WITH ME ROUTES
 */
// Share with specific email
app.post('/api/files/:id/share-email', requireAuth, async (req, res) => {
  const { email } = req.body;
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from('shares')
      .insert([{ 
        file_id: id, 
        grantee_email: email,
        is_public: false 
      }])
      .select();

    if (error) throw error;
    res.json(data);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Get "Shared with Me"
app.get('/api/shared-with-me', requireAuth, async (req, res) => {
  try {
    const myEmail = req.user.email;

    // Join shares with files
    const { data: shares, error } = await supabase
      .from('shares')
      .select(`
        id,
        file:files ( * )
      `)
      .eq('grantee_email', myEmail);

    if (error) throw error;

    // Flatten structure
    const files = shares.map(s => s.file).filter(f => f && !f.is_deleted);
    
    res.json({ folder: { name: 'Shared with me' }, children: { folders: [], files } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// ==========================================
// 4. START SERVER
// ==========================================
app.listen(PORT, () => {
  console.log(`Node Drive Backend running on port ${PORT}`);
});
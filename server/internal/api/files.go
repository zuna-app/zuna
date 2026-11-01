package api

import (
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"zuna/server/internal/store"
)

// Clients split files into 1 MiB plaintext chunks before encrypting them. The
// extra room covers the authentication tag.
const (
	plainChunkBytes = 1 << 20
	chunkOverhead   = 256
	maxChunkBytes   = plainChunkBytes + chunkOverhead
	// Uploads stop with this much of the disk still free, so the database can go on writing.
	defaultMinFreeDiskMB = 1 << 10
)

func (s *Server) fileDir(id string) string {
	return filepath.Join(s.files, id[:2], id)
}

func (s *Server) chunkPath(id string, n int) string {
	return filepath.Join(s.fileDir(id), strconv.Itoa(n))
}

func (s *Server) maxUploadBytes(r *http.Request) (int64, error) {
	mb, err := s.intSetting(r.Context(), "max_upload_mb", defaultUploadMB)
	return int64(mb) << 20, err
}

// diskIsFull reports whether uploads should stop, and says so if they should. Not
// being able to tell is no reason to stop anyone.
func (s *Server) diskIsFull(w http.ResponseWriter) bool {
	if s.cfg.MinFreeDiskMB < 0 {
		return false
	}
	free, err := freeDiskBytes(s.cfg.DataDir)
	if err != nil || free >= uint64(s.cfg.MinFreeDiskMB)<<20 {
		return false
	}
	writeError(w, http.StatusInsufficientStorage, "storage_full", "This server is out of storage for files. Ask its admin to make some room.")
	return true
}

func (s *Server) handleCreateFile(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	var body struct {
		ChunkCount int   `json:"chunk_count"`
		TotalSize  int64 `json:"total_size"`
	}
	if !readJSON(w, r, &body) {
		return
	}
	limit, err := s.maxUploadBytes(r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if body.TotalSize > limit {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large",
			fmt.Sprintf("Files on this server can be up to %d MB.", limit>>20))
		return
	}
	// Every part but the last is full, so the size says how many parts there can be.
	// The count is held to the limit first, so that nothing below can overflow.
	if int64(body.ChunkCount) > limit/plainChunkBytes+1 || body.ChunkCount < 1 || body.TotalSize < 1 ||
		body.TotalSize > int64(body.ChunkCount)*maxChunkBytes || int64(body.ChunkCount-1)*plainChunkBytes >= body.TotalSize {
		writeError(w, http.StatusBadRequest, "bad_request", "The file description isn't valid.")
		return
	}
	if s.diskIsFull(w) {
		return
	}
	id := store.NewID()
	if err := s.db.CreateFile(r.Context(), store.File{
		ID:         id,
		OwnerID:    sess.UserID,
		ChunkCount: body.ChunkCount,
		TotalSize:  body.TotalSize,
	}, s.quotaBytes()); err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id})
}

func (s *Server) handleFileInfo(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	file, err := s.db.File(r.Context(), r.PathValue("id"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	allowed, err := s.db.MayReadFile(r.Context(), file.ID, sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !allowed {
		writeFailure(w, store.ErrNotFound)
		return
	}
	if file.OwnerID != sess.UserID {
		file.OwnerID = ""
	}
	writeJSON(w, http.StatusOK, file)
}

var errBadChunkIndex = errors.New("chunk index out of range")

func (s *Server) chunkFromRequest(r *http.Request) (*store.File, int, error) {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		return nil, 0, store.ErrNotFound
	}
	file, err := s.db.File(r.Context(), id)
	if err != nil {
		return nil, 0, err
	}
	n, err := strconv.Atoi(r.PathValue("n"))
	if err != nil || n < 0 || n >= file.ChunkCount {
		return nil, 0, errBadChunkIndex
	}
	return file, n, nil
}

func writeChunkError(w http.ResponseWriter, err error) {
	if errors.Is(err, errBadChunkIndex) {
		writeError(w, http.StatusBadRequest, "bad_request", "That part of the file doesn't exist.")
		return
	}
	writeFailure(w, err)
}

func (s *Server) handleUploadChunk(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	file, n, err := s.chunkFromRequest(r)
	if err != nil {
		writeChunkError(w, err)
		return
	}
	if file.OwnerID != sess.UserID || file.CompletedAt != nil {
		writeError(w, http.StatusForbidden, "forbidden", "This upload can't be changed.")
		return
	}
	limit, err := s.maxUploadBytes(r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// An upload described before the count was held to the limit may still be around.
	if int64(file.ChunkCount) > limit/plainChunkBytes+1 {
		writeError(w, http.StatusForbidden, "forbidden", "This upload can't be changed.")
		return
	}
	if s.diskIsFull(w) {
		return
	}
	// A slow connection gets longer for this than for an ordinary request.
	http.NewResponseController(w).SetReadDeadline(time.Now().Add(chunkReadTimeout))
	if err := os.MkdirAll(s.fileDir(file.ID), 0o755); err != nil {
		writeFailure(w, err)
		return
	}
	tmp, err := os.CreateTemp(s.fileDir(file.ID), "upload-*")
	if err != nil {
		writeFailure(w, err)
		return
	}
	defer os.Remove(tmp.Name())
	written, err := io.Copy(tmp, http.MaxBytesReader(w, r.Body, maxChunkBytes))
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil || written == 0 {
		writeError(w, http.StatusBadRequest, "bad_request", "That part of the upload couldn't be read.")
		return
	}
	// What arrives counts against what the upload said it would be, as it arrives.
	replacing := int64(0)
	if existing, err := os.Stat(s.chunkPath(file.ID, n)); err == nil {
		replacing = existing.Size()
	}
	if file.Received+written-replacing > file.TotalSize+int64(file.ChunkCount)*chunkOverhead {
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "That's more than this upload said it would be.")
		return
	}
	if err := os.Rename(tmp.Name(), s.chunkPath(file.ID, n)); err != nil {
		writeFailure(w, err)
		return
	}
	if err := s.db.AddReceived(r.Context(), file.ID, written-replacing); err != nil {
		writeFailure(w, err)
		return
	}
	writeOK(w)
}

func (s *Server) handleCompleteFile(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	id := r.PathValue("id")
	if !store.ValidID(id) {
		writeFailure(w, store.ErrNotFound)
		return
	}
	file, err := s.db.File(r.Context(), id)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if file.OwnerID != sess.UserID {
		writeError(w, http.StatusForbidden, "forbidden", "This upload belongs to someone else.")
		return
	}
	var total int64
	for n := range file.ChunkCount {
		info, err := os.Stat(s.chunkPath(id, n))
		if err != nil {
			writeError(w, http.StatusConflict, "incomplete", "Some parts of the file are missing.")
			return
		}
		total += info.Size()
	}
	limit, err := s.maxUploadBytes(r)
	if err != nil {
		writeFailure(w, err)
		return
	}
	if total > limit+int64(file.ChunkCount)*256 {
		s.removeFiles(r.Context(), []string{id})
		writeError(w, http.StatusRequestEntityTooLarge, "too_large", "That file is too large for this server.")
		return
	}
	if err := s.db.CompleteFile(r.Context(), id); err != nil {
		writeFailure(w, err)
		return
	}
	// Files that aren't sent in a message, such as group pictures, say so here.
	// Otherwise cleanup would treat them as abandoned uploads.
	if r.URL.Query().Get("attach") == "1" {
		if err := s.db.AttachFile(r.Context(), id, sess.UserID); err != nil {
			writeFailure(w, err)
			return
		}
	}
	writeOK(w)
}

func (s *Server) handleDownloadChunk(w http.ResponseWriter, r *http.Request, sess *store.Session) {
	file, n, err := s.chunkFromRequest(r)
	if err != nil {
		writeChunkError(w, err)
		return
	}
	allowed, err := s.db.MayReadFile(r.Context(), file.ID, sess.UserID)
	if err != nil {
		writeFailure(w, err)
		return
	}
	// The same answer as for a file that doesn't exist.
	if !allowed {
		writeFailure(w, store.ErrNotFound)
		return
	}
	if file.CompletedAt == nil {
		writeError(w, http.StatusNotFound, "not_found", "This file hasn't finished uploading.")
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeFile(w, r, s.chunkPath(file.ID, n))
}

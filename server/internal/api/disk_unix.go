//go:build !windows

package api

import "syscall"

// freeDiskBytes is how much of the disk holding a path is free for this program.
func freeDiskBytes(path string) (uint64, error) {
	var stat syscall.Statfs_t
	if err := syscall.Statfs(path, &stat); err != nil {
		return 0, err
	}
	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}

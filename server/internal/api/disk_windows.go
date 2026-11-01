package api

import "golang.org/x/sys/windows"

// freeDiskBytes is how much of the disk holding a path is free for this program.
func freeDiskBytes(path string) (uint64, error) {
	name, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var free, total, totalFree uint64
	if err := windows.GetDiskFreeSpaceEx(name, &free, &total, &totalFree); err != nil {
		return 0, err
	}
	return free, nil
}

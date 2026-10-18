//! The Vulkan functions whisper.cpp's backend calls by name (the rest it looks up through
//! `vkGetInstanceProcAddr`), defined here so the addon doesn't link the Vulkan loader. Linked, a
//! computer without one (no GPU driver) couldn't load the addon at all; this way the loader is
//! opened on first use, and without it Whisper runs on the CPU.

use std::ffi::{c_char, c_void, CStr};
use std::sync::OnceLock;

type Handle = *mut c_void;
type VoidFunction = Option<unsafe extern "system" fn()>;
type GetInstanceProcAddr = unsafe extern "system" fn(Handle, *const c_char) -> VoidFunction;
type GetPhysicalDeviceFeatures2 = unsafe extern "system" fn(Handle, *mut c_void);
type CmdCopyBuffer = unsafe extern "system" fn(Handle, Handle, Handle, u32, *const c_void);
type EnumerateInstanceVersion = unsafe extern "system" fn(*mut u32) -> i32;

#[cfg(windows)]
const LOADER: &str = "vulkan-1.dll";
#[cfg(not(windows))]
const LOADER: &str = "libvulkan.so.1";

const VK_ERROR_INITIALIZATION_FAILED: i32 = -3;

struct Loader {
    get_instance_proc_addr: GetInstanceProcAddr,
    get_physical_device_features2: GetPhysicalDeviceFeatures2,
    cmd_copy_buffer: CmdCopyBuffer,
}

/// The system's Vulkan loader, if it has one. Never unloaded: whisper.cpp keeps what it hands out.
fn loader() -> Option<&'static Loader> {
    static LOADER_FUNCTIONS: OnceLock<Option<Loader>> = OnceLock::new();
    LOADER_FUNCTIONS
        .get_or_init(|| unsafe {
            let library: &'static libloading::Library = Box::leak(Box::new(libloading::Library::new(LOADER).ok()?));
            Some(Loader {
                get_instance_proc_addr: *library.get(b"vkGetInstanceProcAddr").ok()?,
                get_physical_device_features2: *library.get(b"vkGetPhysicalDeviceFeatures2").ok()?,
                cmd_copy_buffer: *library.get(b"vkCmdCopyBuffer").ok()?,
            })
        })
        .as_ref()
}

/// Stands in for `vkEnumerateInstanceVersion` without a loader: whisper.cpp asks it first and takes
/// the failure as "no Vulkan here".
unsafe extern "system" fn no_vulkan(_version: *mut u32) -> i32 {
    VK_ERROR_INITIALIZATION_FAILED
}

/// # Safety
/// As Vulkan's `vkGetInstanceProcAddr`: `name` is a C string.
#[no_mangle]
pub unsafe extern "system" fn vkGetInstanceProcAddr(instance: Handle, name: *const c_char) -> VoidFunction {
    match loader() {
        Some(loader) => (loader.get_instance_proc_addr)(instance, name),
        None if CStr::from_ptr(name).to_bytes() == b"vkEnumerateInstanceVersion" => {
            Some(std::mem::transmute::<EnumerateInstanceVersion, unsafe extern "system" fn()>(no_vulkan))
        }
        None => None,
    }
}

// The two below are only called with a device, which only a loader that is there can give.

/// # Safety
/// As Vulkan's `vkGetPhysicalDeviceFeatures2`.
#[no_mangle]
pub unsafe extern "system" fn vkGetPhysicalDeviceFeatures2(device: Handle, features: *mut c_void) {
    if let Some(loader) = loader() {
        (loader.get_physical_device_features2)(device, features);
    }
}

/// # Safety
/// As Vulkan's `vkCmdCopyBuffer`.
#[no_mangle]
pub unsafe extern "system" fn vkCmdCopyBuffer(
    buffer: Handle,
    source: Handle,
    destination: Handle,
    count: u32,
    regions: *const c_void,
) {
    if let Some(loader) = loader() {
        (loader.cmd_copy_buffer)(buffer, source, destination, count, regions);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn asks_the_loader_or_says_there_is_no_vulkan() {
        let version = unsafe { vkGetInstanceProcAddr(std::ptr::null_mut(), c"vkEnumerateInstanceVersion".as_ptr()) };
        let version: EnumerateInstanceVersion = unsafe { std::mem::transmute(version.expect("always answered")) };
        let mut found = 0;
        let result = unsafe { version(&mut found) };
        if loader().is_some() {
            assert_eq!((result, found >= 1 << 22), (0, true), "Vulkan 1.0 or newer");
        } else {
            assert_eq!(result, VK_ERROR_INITIALIZATION_FAILED);
        }
    }
}

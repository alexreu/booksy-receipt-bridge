/**
 * Native messaging host name (plan section 10).
 *
 * This string must stay stable for the life of the project: it is the key the
 * browser looks the host up under, and it is written into the registry on
 * Windows and into a manifest file elsewhere. Changing it silently breaks every
 * existing install.
 */
export const NATIVE_HOST_NAME = 'com.alexdevlab.booksy_receipt_bridge';

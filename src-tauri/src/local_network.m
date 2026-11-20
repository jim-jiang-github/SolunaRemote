#import <Foundation/Foundation.h>
#import <Network/Network.h>
#import <dispatch/dispatch.h>

bool soluna_local_network_denied(const char *host) {
    const NSOperatingSystemVersion minimum = {15, 0, 0};
    if ([NSProcessInfo.processInfo isOperatingSystemAtLeastVersion:minimum]) {
        @autoreleasepool {
            // Use the control endpoint, not the rate-limited authentication service.
            nw_endpoint_t endpoint = nw_endpoint_create_host(host, "47989");
            nw_parameters_t parameters = nw_parameters_create_secure_tcp(
                NW_PARAMETERS_DISABLE_PROTOCOL, NW_PARAMETERS_DEFAULT_CONFIGURATION);
            nw_connection_t connection = nw_connection_create(endpoint, parameters);
            if (!connection)
                return false;

            dispatch_semaphore_t finished = dispatch_semaphore_create(0);
            __block bool denied = false;
            __block bool decided = false;
            __weak nw_connection_t weak_connection = connection;
            nw_connection_set_queue(
                connection, dispatch_queue_create("soluna.local-network", DISPATCH_QUEUE_SERIAL));
            nw_connection_set_state_changed_handler(
                connection, ^(nw_connection_state_t state, nw_error_t unused_error) {
                  (void)unused_error;
                  if (decided)
                      return;
                  if (state == nw_connection_state_waiting || state == nw_connection_state_failed) {
                      nw_connection_t active = weak_connection;
                      nw_path_t path = active ? nw_connection_copy_current_path(active) : NULL;
                      denied = path && nw_path_get_status(path) == nw_path_status_unsatisfied &&
                               nw_path_get_unsatisfied_reason(path) ==
                                   nw_path_unsatisfied_reason_local_network_denied;
                      if (!denied && state == nw_connection_state_waiting)
                          return;
                  } else if (state != nw_connection_state_ready) {
                      return;
                  }
                  decided = true;
                  dispatch_semaphore_signal(finished);
                });
            nw_connection_start(connection);
            bool completed =
                dispatch_semaphore_wait(
                    finished, dispatch_time(DISPATCH_TIME_NOW, 1500 * NSEC_PER_MSEC)) == 0;
            nw_connection_cancel(connection);
            return completed && denied;
        }
    }
    return false;
}

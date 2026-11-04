import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { CurrencyPipe, DatePipe } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { catchError, EMPTY, exhaustMap, forkJoin, interval, Subscription } from 'rxjs';
import { ParticipantCardComponent } from '@app/components/group-orders/participant-card/participant-card.component';
import { ModalComponent } from '@app/shared/custom-components/modal/modal.component';
import { GroupOrdersService } from '@app/services/group-orders/group-orders.service';
import { ToastService } from '@app/services/toast/toast.service';
import { GuestInvite } from '@app/models/reservations/guest-invite.model';
import { Participant } from '@app/models/group-orders/participant.model';
import { GroupReservationStatus } from '@app/models/group-orders/group-status.model';
import { consolidatePreOrder } from '@app/shared/helpers/consolidate-pre-order';

@Component({
  selector: 'app-group-order-page',
  standalone: true,
  imports: [CurrencyPipe, DatePipe, ParticipantCardComponent, ModalComponent],
  templateUrl: './group-order-page.component.html',
  styleUrl: './group-order-page.component.scss',
  changeDetection: ChangeDetectionStrategy.Eager,
})
export class GroupOrderPageComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly groupOrdersService = inject(GroupOrdersService);
  private readonly toastService = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);

  private pollingSubscription: Subscription | null = null;

  readonly reservationId = signal<string>('');
  readonly invite = signal<GuestInvite | null>(null);
  readonly participants = signal<Participant[]>([]);
  readonly ownerSessionId = signal<string>('');
  readonly groupStatus = signal<GroupReservationStatus>('Open');

  readonly isLoading = signal(true);
  readonly errorStatus = signal<number | null>(null);
  readonly isModalOpen = signal(false);
  readonly isSubmitting = signal(false);

  readonly lastUpdatedAt = signal<Date | null>(null);
  readonly refreshError = signal<string | null>(null);
  readonly guestToRemove = signal<Participant | null>(null);
  readonly isRemovingGuest = signal(false);

  readonly consolidatedOrder = computed(() => {
    return consolidatePreOrder(this.participants());
  });

  readonly grandTotal = computed(() => {
    return this.consolidatedOrder().total;
  });

  readonly unsubmittedCount = computed(() => {
    return this.participants().filter((p) => !p.isSubmitted).length;
  });

  readonly hasDishes = computed(() => {
    return this.participants().some((p) => p.items && p.items.length > 0);
  });

  readonly canSubmit = computed(() => {
    return !this.isSubmitting() && this.consolidatedOrder().items.length > 0;
  });

  readonly errorMessage = computed(() => {
    const status = this.errorStatus();
    if (status === 404) {
      return 'Group reservation not found';
    }
    if (status !== null) {
      return 'Failed to load group reservation. Please try again.';
    }
    return null;
  });

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('reservationId') ?? '';
    this.reservationId.set(id);
    this.loadData();
  }

  ngOnDestroy(): void {
    this.stopPolling();
  }

  loadData(): void {
    const resId = this.reservationId();
    if (!resId) return;

    this.stopPolling();
    this.isLoading.set(true);
    this.errorStatus.set(null);

    this.groupOrdersService.getGroupInvite$(resId).subscribe({
      next: (invite) => {
        this.invite.set(invite);
        forkJoin({
          sessions: this.groupOrdersService.getSessions$(invite.GroupReservationId),
          ownerId: this.groupOrdersService.getOwnerSessionId$(resId),
          statusRes: this.groupOrdersService.getStatus$(invite.GroupReservationId),
        }).subscribe({
          next: ({ sessions, ownerId, statusRes }) => {
            this.participants.set(sessions.participants);
            this.ownerSessionId.set(ownerId);
            this.groupStatus.set(statusRes.status);
            this.lastUpdatedAt.set(new Date());
            this.refreshError.set(null);
            this.isLoading.set(false);

            if (statusRes.status === 'Open') {
              this.startPolling(invite.GroupReservationId);
            }
          },
          error: (err) => {
            this.errorStatus.set(err.status ?? 500);
            this.isLoading.set(false);
          },
        });
      },
      error: (err) => {
        this.errorStatus.set(err.status ?? 500);
        this.isLoading.set(false);
      },
    });
  }

  manualRefresh(): void {
    const invite = this.invite();
    if (!invite) return;

    forkJoin({
      sessions: this.groupOrdersService.getSessions$(invite.GroupReservationId, { silent: true }),
      statusRes: this.groupOrdersService.getStatus$(invite.GroupReservationId, { silent: true }),
    }).subscribe({
      next: ({ sessions, statusRes }) => {
        this.participants.set(sessions.participants);
        this.groupStatus.set(statusRes.status);
        this.lastUpdatedAt.set(new Date());
        this.refreshError.set(null);
        if (statusRes.status === 'Submitted') {
          this.stopPolling();
        }
      },
      error: () => {
        this.refreshError.set(
          `Couldn’t refresh. Showing data from ${this.lastUpdatedAt()?.toLocaleTimeString() ?? ''}`
        );
      },
    });
  }

  private startPolling(groupReservationId: string): void {
    this.stopPolling();

    this.pollingSubscription = interval(15_000)
      .pipe(
        exhaustMap(() =>
          forkJoin({
            sessions: this.groupOrdersService.getSessions$(groupReservationId, { silent: true }),
            statusRes: this.groupOrdersService.getStatus$(groupReservationId, { silent: true }),
          }).pipe(
            catchError(() => {
              this.refreshError.set(
                `Couldn’t refresh. Showing data from ${this.lastUpdatedAt()?.toLocaleTimeString() ?? ''}`
              );
              return EMPTY;
            })
          )
        )
      )
      .subscribe(({ sessions, statusRes }) => {
        this.participants.set(sessions.participants);
        this.groupStatus.set(statusRes.status);
        this.lastUpdatedAt.set(new Date());
        this.refreshError.set(null);

        if (statusRes.status === 'Submitted') {
          this.stopPolling();
        }
      });
  }

  private stopPolling(): void {
    if (this.pollingSubscription) {
      this.pollingSubscription.unsubscribe();
      this.pollingSubscription = null;
    }
  }

  openSubmitModal(): void {
    this.isModalOpen.set(true);
  }

  closeModal(): void {
    this.isModalOpen.set(false);
  }

  confirmSubmit(): void {
    if (this.isSubmitting()) {
      return;
    }

    const invite = this.invite();
    const resId = this.reservationId();
    if (!invite || !resId) return;

    this.isSubmitting.set(true);
    this.groupOrdersService.submit$(invite.GroupReservationId, resId).subscribe({
      next: () => {
        this.isSubmitting.set(false);
        this.isModalOpen.set(false);
        this.groupStatus.set('Submitted');
        this.stopPolling();
        this.toastService.success('Pre-order sent to the restaurant');
      },
      error: () => {
        this.isSubmitting.set(false);
        this.isModalOpen.set(false);
      },
    });
  }

  openRemoveGuestModal(participant: Participant): void {
    this.guestToRemove.set(participant);
  }

  closeRemoveGuestModal(): void {
    this.guestToRemove.set(null);
  }

  confirmRemoveGuest(): void {
    const guest = this.guestToRemove();
    const invite = this.invite();
    if (!guest || !invite || this.isRemovingGuest()) return;

    this.isRemovingGuest.set(true);
    this.groupOrdersService.removeSession$(invite.GroupReservationId, guest.id).subscribe({
      next: (response) => {
        this.isRemovingGuest.set(false);
        this.participants.set(response.participants);
        this.closeRemoveGuestModal();
        this.toastService.success(`Removed ${guest.name}`);
      },
      error: () => {
        this.isRemovingGuest.set(false);
        this.closeRemoveGuestModal();
      },
    });
  }
}

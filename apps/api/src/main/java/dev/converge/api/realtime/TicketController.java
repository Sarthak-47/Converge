package dev.converge.api.realtime;

import java.util.UUID;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

import dev.converge.api.auth.AppUser;
import dev.converge.api.realtime.TicketService.Grant;
import dev.converge.api.realtime.TicketService.Ticket;

@RestController
public class TicketController {

    public record TicketRequest(@NotNull UUID fileId) {
    }

    public record AuthorizeRequest(@NotBlank String ticket, @NotNull UUID documentName) {
    }

    private final TicketService tickets;

    public TicketController(TicketService tickets) {
        this.tickets = tickets;
    }

    @PostMapping("/api/v1/realtime/tickets")
    ResponseEntity<Ticket> issue(@AuthenticationPrincipal AppUser user, @Valid @RequestBody TicketRequest body) {
        return ResponseEntity.status(HttpStatus.CREATED).body(tickets.issue(body.fileId(), user.id()));
    }

    /** Called only by the collaboration service, over the private network, with the internal token. */
    @PostMapping("/internal/collab/authorize")
    Grant authorize(@Valid @RequestBody AuthorizeRequest body) {
        return tickets.redeem(body.ticket(), body.documentName());
    }
}

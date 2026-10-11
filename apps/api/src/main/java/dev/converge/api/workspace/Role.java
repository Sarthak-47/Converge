package dev.converge.api.workspace;

/** Workspace roles, lowest to highest (design §14.2). Each role can do everything the roles below it can. */
public enum Role {
    VIEWER, COMMENTER, EDITOR, OWNER;

    public boolean atLeast(Role required) {
        return compareTo(required) >= 0;
    }
}
